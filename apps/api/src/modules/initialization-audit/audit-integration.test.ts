import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ROLES } from '@potato-corner/shared';
import type { InitializationRunStatus } from '@prisma/client';

/**
 * R12 — Authorization and audit integration.
 *
 * Gated on TEST_DATABASE_URL alone (established precedent — see
 * run-lifecycle.service.test.ts), NOT on TEST_REDIS_URL: this module has no
 * Redis dependency.
 */
const canRunIntegrationTests = Boolean(process.env.TEST_DATABASE_URL);

const { requireSuperAdmin, writeInitAuditLogEntry } = await import('./audit-integration.js');
const { prisma } = await import('../../lib/prisma.js');
const {
  markDryRunValidated,
  startApplying,
  markApplied,
  markApplyFailed,
  startRollbackAssessment,
  markRollbackBlocked,
  startRollingBack,
  markRolledBack,
  markRollbackPartial,
} = await import('./run-lifecycle.service.js');

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, query: {}, body: {}, ...overrides } as unknown as Request;
}

function mockRes(): Response {
  const res = {} as Response & { statusCode?: number; jsonBody?: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((body: unknown) => {
    res.jsonBody = body;
    return res;
  }) as unknown as Response['json'];
  return res;
}

describe('requireSuperAdmin guard', () => {
  it('is the same reused adminOnly middleware, not a reinvented check', async () => {
    const { adminOnly } = await import('../../middleware/authorize.js');
    expect(requireSuperAdmin).toBe(adminOnly);
  });

  it('rejects a non-Super-Admin JWT with 403 INSUFFICIENT_PERMISSIONS', () => {
    const req = mockReq({
      user: { user_id: 'u1', role: ROLES.SUPERVISOR, email: 's@test.com', branch_ids: ['branch-1'], iat: 0, exp: 9999999999 },
    });
    const res = mockRes();
    const next = vi.fn();
    requireSuperAdmin(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'INSUFFICIENT_PERMISSIONS' }) }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a staff JWT with 403', () => {
    const req = mockReq({
      user: { user_id: 'u1', role: ROLES.STAFF, email: 't@test.com', branch_ids: ['branch-1'], iat: 0, exp: 9999999999 },
    });
    const res = mockRes();
    const next = vi.fn();
    requireSuperAdmin(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a Super Admin JWT and calls next()', () => {
    const req = mockReq({
      user: { user_id: 'u1', role: ROLES.SUPER_ADMIN, email: 'a@test.com', iat: 0, exp: 9999999999 },
    });
    const res = mockRes();
    const next = vi.fn();
    requireSuperAdmin(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe.skipIf(!canRunIntegrationTests)('writeInitAuditLogEntry integration', () => {
  let userId: string;
  const createdRunIds: string[] = [];
  const createdAuditLogIds: string[] = [];

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `r12-audit-${randomUUID()}@potatocorner.test`,
        passwordHash: 'unused-in-this-suite',
        role: 'super_admin',
        firstName: 'R12',
        lastName: 'Audit Test',
        employmentType: 'regular',
        mustChangePassword: false,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { id: { in: createdAuditLogIds } } });
    await prisma.initializationRun.deleteMany({ where: { id: { in: createdRunIds } } });
    await prisma.user.delete({ where: { id: userId } });
  });

  async function createRun(status: InitializationRunStatus): Promise<{ id: string; version: number }> {
    const run = await prisma.initializationRun.create({
      data: {
        migrationBatch: `r12-test-${randomUUID()}`,
        initializationType: 'REFERENCE_DATA',
        manifestVersion: 1,
        manifestFingerprint: 'test-fingerprint',
        manifestSnapshot: {},
        targetEnvironment: 'test',
        executionMode: 'DRY_RUN',
        status,
        initiatedBy: userId,
      },
    });
    createdRunIds.push(run.id);
    return { id: run.id, version: run.version };
  }

  /** Runs the transition, writes the audit entry, and returns both the updated
   * run and the newly-created AuditLog row for assertion. */
  async function transitionAndAudit<T extends { id: string; status: InitializationRunStatus; initiatedBy: string }>(
    transition: () => Promise<T>,
  ) {
    const before = await prisma.auditLog.count();
    const updated = await transition();
    await writeInitAuditLogEntry(updated.status, updated as never);
    const after = await prisma.auditLog.count();
    expect(after).toBe(before + 1);

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'InitializationRun', entityId: updated.id },
      orderBy: { createdAt: 'desc' },
    });
    createdAuditLogIds.push(row.id);
    return { updated, auditRow: row };
  }

  it('PLANNED -> DRY_RUN_VALIDATED writes exactly one AuditLog row with correct fields', async () => {
    const run = await createRun('PLANNED');
    const { updated, auditRow } = await transitionAndAudit(() =>
      markDryRunValidated({ runId: run.id, expectedVersion: run.version }),
    );
    expect(auditRow.entityType).toBe('InitializationRun');
    expect(auditRow.entityId).toBe(updated.id);
    expect(auditRow.actorId).toBe(updated.initiatedBy);
    expect(auditRow.actorRole).toBe('super_admin');
    expect(auditRow.action).toBe('DRY_RUN_VALIDATED');
  });

  it('DRY_RUN_VALIDATED -> APPLYING writes exactly one AuditLog row', async () => {
    const run = await createRun('DRY_RUN_VALIDATED');
    const { auditRow } = await transitionAndAudit(() => startApplying({ runId: run.id, expectedVersion: run.version }));
    expect(auditRow.action).toBe('APPLYING');
  });

  it('APPLYING -> APPLIED writes exactly one AuditLog row', async () => {
    const run = await createRun('APPLYING');
    const { auditRow } = await transitionAndAudit(() => markApplied({ runId: run.id, expectedVersion: run.version }));
    expect(auditRow.action).toBe('APPLIED');
  });

  it('APPLYING -> APPLY_FAILED writes exactly one AuditLog row', async () => {
    const run = await createRun('APPLYING');
    const { auditRow } = await transitionAndAudit(() =>
      markApplyFailed({ runId: run.id, expectedVersion: run.version, failureReason: 'db unreachable' }),
    );
    expect(auditRow.action).toBe('APPLY_FAILED');
  });

  it('APPLIED -> ROLLBACK_ASSESSING writes exactly one AuditLog row', async () => {
    const run = await createRun('APPLIED');
    const { auditRow } = await transitionAndAudit(() =>
      startRollbackAssessment({ runId: run.id, expectedVersion: run.version }),
    );
    expect(auditRow.action).toBe('ROLLBACK_ASSESSING');
  });

  it('ROLLBACK_ASSESSING -> ROLLBACK_BLOCKED writes exactly one AuditLog row', async () => {
    const run = await createRun('ROLLBACK_ASSESSING');
    const { auditRow } = await transitionAndAudit(() =>
      markRollbackBlocked({ runId: run.id, expectedVersion: run.version }),
    );
    expect(auditRow.action).toBe('ROLLBACK_BLOCKED');
  });

  it('ROLLBACK_ASSESSING -> ROLLING_BACK writes exactly one AuditLog row', async () => {
    const run = await createRun('ROLLBACK_ASSESSING');
    const { auditRow } = await transitionAndAudit(() =>
      startRollingBack({ runId: run.id, expectedVersion: run.version }),
    );
    expect(auditRow.action).toBe('ROLLING_BACK');
  });

  it('ROLLING_BACK -> ROLLED_BACK writes exactly one AuditLog row', async () => {
    const run = await createRun('ROLLING_BACK');
    const { auditRow } = await transitionAndAudit(() => markRolledBack({ runId: run.id, expectedVersion: run.version }));
    expect(auditRow.action).toBe('ROLLED_BACK');
  });

  it('ROLLING_BACK -> ROLLBACK_PARTIAL writes exactly one AuditLog row', async () => {
    const run = await createRun('ROLLING_BACK');
    const { auditRow } = await transitionAndAudit(() =>
      markRollbackPartial({ runId: run.id, expectedVersion: run.version, failureReason: 'partial rollback' }),
    );
    expect(auditRow.action).toBe('ROLLBACK_PARTIAL');
  });

  it('a full PLANNED -> ... -> ROLLED_BACK lifecycle produces one AuditLog row per transition, hash-chained', async () => {
    // Six chained transitions x two round trips each against a remote
    // dev DB (~3.7s/test observed elsewhere in this suite) comfortably
    // exceeds vitest's default 20s per-test timeout.
    const run = await createRun('PLANNED');

    const r1 = await transitionAndAudit(() => markDryRunValidated({ runId: run.id, expectedVersion: run.version }));
    const r2 = await transitionAndAudit(() => startApplying({ runId: run.id, expectedVersion: r1.updated.version }));
    const r3 = await transitionAndAudit(() => markApplied({ runId: run.id, expectedVersion: r2.updated.version }));
    const r4 = await transitionAndAudit(() =>
      startRollbackAssessment({ runId: run.id, expectedVersion: r3.updated.version }),
    );
    const r5 = await transitionAndAudit(() => startRollingBack({ runId: run.id, expectedVersion: r4.updated.version }));
    const r6 = await transitionAndAudit(() => markRolledBack({ runId: run.id, expectedVersion: r5.updated.version }));

    const rows = [r1, r2, r3, r4, r5, r6].map((r) => r.auditRow);
    // Each row's currentHash must be unique (distinct chain links).
    expect(new Set(rows.map((r) => r.currentHash)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.entityType).toBe('InitializationRun');
      expect(row.entityId).toBe(run.id);
      expect(row.actorId).toBe(userId);
      expect(row.actorRole).toBe('super_admin');
    }
  }, 60000);
});
