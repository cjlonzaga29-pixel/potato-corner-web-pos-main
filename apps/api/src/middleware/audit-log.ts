import { createHash } from 'node:crypto';
import * as Sentry from '@sentry/node';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';

const GENESIS_HASH = '0'.repeat(64);

export interface AuditLogEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorId?: string | null;
  actorRole: string;
  branchId?: string | null;
  beforeState?: unknown;
  afterState?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Appends one hash-chained audit log record. currentHash = SHA-256(all
 * fields + previousHash) — any historical modification breaks the chain
 * and is detectable (Architecture doc §4.2). Throws on failure; `onHash`
 * receives the hash before the INSERT is sent, so a caller can tell whether
 * an INSERT whose reply was lost actually landed.
 */
async function appendAuditLog(entry: AuditLogEntry, onHash?: (currentHash: string) => void): Promise<void> {
  const last = await prisma.auditLog.findFirst({ orderBy: { createdAt: 'desc' } });
  const previousHash = last?.currentHash ?? GENESIS_HASH;

  const fieldsForHash = JSON.stringify({
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    actorId: entry.actorId ?? null,
    actorRole: entry.actorRole,
    branchId: entry.branchId ?? null,
    beforeState: entry.beforeState ?? null,
    afterState: entry.afterState ?? null,
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent ?? null,
  });
  const currentHash = createHash('sha256').update(fieldsForHash + previousHash).digest('hex');
  onHash?.(currentHash);

  await prisma.auditLog.create({
    data: {
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? undefined,
      actorId: entry.actorId ?? undefined,
      actorRole: entry.actorRole,
      branchId: entry.branchId ?? undefined,
      beforeState: (entry.beforeState ?? undefined) as never,
      afterState: (entry.afterState ?? undefined) as never,
      ipAddress: entry.ipAddress ?? undefined,
      userAgent: entry.userAgent ?? undefined,
      previousHash,
      currentHash,
    },
  });
}

/**
 * Appends one hash-chained audit log record. Never throws into the caller's
 * request/response cycle; logging failures are swallowed after being
 * reported, since audit logging must never block or fail a real operation.
 */
export async function recordAuditLog(entry: AuditLogEntry): Promise<void> {
  try {
    await appendAuditLog(entry);
  } catch (error) {
    console.error('Failed to write audit log entry:', error);
  }
}

const COMMITTED_AUDIT_RETRY_DELAYS_MS = [250, 1000];

/**
 * POS-PERF-P38R3 — for an entry describing a write that has already
 * committed (so the caller must still report success). A failed append is
 * retried, re-reading the chain's tail each time; before each retry it
 * checks whether the previous attempt's row landed anyway (a lost reply to
 * an INSERT that committed), so an entry is never written twice. If every
 * attempt fails it is not dropped silently: it goes to Sentry and to a
 * structured `AUDIT_ENTRY_NOT_RECORDED` error log carrying the full entry,
 * so it can be re-entered. This is not a durable queue — a process crash
 * before the append still loses the entry (see the P38 runbook).
 */
export async function recordCommittedAuditLog(entry: AuditLogEntry, retryDelaysMs: number[] = COMMITTED_AUDIT_RETRY_DELAYS_MS): Promise<void> {
  const attempted: { hash: string | null } = { hash: null };
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      if (attempted.hash) {
        const landed = await prisma.auditLog.findFirst({
          where: { entityType: entry.entityType, entityId: entry.entityId ?? null, currentHash: attempted.hash },
          select: { id: true },
        });
        if (landed) return;
      }
      await appendAuditLog(entry, (hash) => {
        attempted.hash = hash;
      });
      return;
    } catch (error) {
      lastError = error;
      const delay = retryDelaysMs[attempt];
      if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  Sentry.captureException(lastError, { tags: { audit_action: entry.action }, extra: { entry } });
  console.error('AUDIT_ENTRY_NOT_RECORDED', { entry, error: lastError instanceof Error ? lastError.message : String(lastError) });
}

/**
 * Express middleware form: reads actor context from the authenticated
 * request and writes the audit entry after the response is sent, so audit
 * logging never adds latency to the request itself. Route handlers that
 * want before/after state recorded should set res.locals.auditEntityId /
 * auditBeforeState / auditAfterState before responding.
 */
export function auditLog(action: string, entityType: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;

      const branchId =
        req.user && 'branch_ids' in req.user && req.user.branch_ids.length > 0
          ? req.user.branch_ids[0]
          : null;

      void recordAuditLog({
        action,
        entityType,
        entityId: res.locals.auditEntityId as string | undefined,
        actorId: req.user?.user_id ?? null,
        actorRole: req.user?.role ?? 'anonymous',
        branchId,
        beforeState: res.locals.auditBeforeState,
        afterState: res.locals.auditAfterState,
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
    });
    next();
  };
}
