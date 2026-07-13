import { createHash } from 'node:crypto';
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
 * and is detectable (Architecture doc §4.2). Never throws into the caller's
 * request/response cycle; logging failures are swallowed after being
 * reported, since audit logging must never block or fail a real operation.
 */
export async function recordAuditLog(entry: AuditLogEntry): Promise<void> {
  try {
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
  } catch (error) {
    console.error('Failed to write audit log entry:', error);
  }
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
