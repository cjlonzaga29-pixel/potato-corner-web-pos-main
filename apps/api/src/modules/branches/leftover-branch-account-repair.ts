import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ROLES } from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';
import {
  REMOVED_ACCOUNT_MARKER_TTL_MS,
  removedAccountRevocationHash,
} from '../../lib/verify-access-token.js';
import { recordAuditLog } from '../../middleware/audit-log.js';

/**
 * POS-PERF-P68 — diagnosis and exact-ID repair of leftover branch login
 * accounts: role `branch` users with no live branch assignment. Before P67, a
 * branch Delete cascaded the branch's assignments but left its login account
 * (and its email) behind, so Create Branch kept refusing that email.
 *
 * Nothing here guesses ownership from an email pattern or a missing branch.
 * `diagnose` lists every candidate with its evidence (assignment rows,
 * the BRANCH_ACCOUNT_CREATED audit entry and the historical branch record
 * it names). A person reviews it and writes a manifest of exact ids and
 * emails. A dry run reports what would happen; an execution re-reads each
 * account under its row lock and deletes it only if it is still a role
 * `branch` account with the same email and no live assignment. Deletion
 * follows the P66 lifecycle: the removed-account marker ends any token, the
 * `people` attribution record stays, and history is not touched. No
 * migration or automatic job runs this.
 */
export const leftoverRepairManifestSchema = z.object({
  /** The active Super Admin named in the audit log for each deletion. */
  actor_user_id: z.string().uuid(),
  accounts: z
    .array(
      z.object({
        id: z.string().uuid(),
        /** Exact login email as diagnosed (compared case-insensitively). */
        email: z.string().email(),
        /** Why this account is confirmed to be a leftover (e.g. "created for branch PC-MNL-003, deleted 2026-10-02 per audit"). */
        evidence: z.string().trim().min(10),
      }),
    )
    .min(1)
    .refine(
      (accounts) => new Set(accounts.map((a) => a.id)).size === accounts.length,
      'Duplicate account id',
    ),
});
export type LeftoverRepairManifest = z.infer<typeof leftoverRepairManifestSchema>;

export interface LeftoverCandidate {
  id: string;
  email: string | null;
  created_at: string;
  p64_removed_at: string | null;
  assignment_rows: { branch_id: string; removed_at: string | null }[];
  /** Branch named by the account's BRANCH_ACCOUNT_CREATED audit entry, with its historical record. */
  created_for: {
    branch_id: string;
    name: string | null;
    code: string | null;
    branch_deleted_at: string | null;
  } | null;
}

/** Read-only: every role `branch` account with no live assignment, with the evidence a reviewer needs. */
export async function diagnoseLeftoverBranchAccounts(): Promise<LeftoverCandidate[]> {
  const users = await prisma.user.findMany({
    where: { role: 'branch', NOT: { branchAssignments: { some: { removedAt: null } } } },
    select: {
      id: true,
      email: true,
      createdAt: true,
      deletedAt: true,
      branchAssignments: { select: { branchId: true, removedAt: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  const created = await prisma.auditLog.findMany({
    where: { action: 'BRANCH_ACCOUNT_CREATED', entityId: { in: users.map((u) => u.id) } },
    select: { entityId: true, branchId: true },
  });
  const branchIdByUser = new Map(
    created.filter((c) => c.branchId).map((c) => [c.entityId, c.branchId as string]),
  );
  const records = await prisma.branchRecord.findMany({
    where: { id: { in: [...new Set(branchIdByUser.values())] } },
    select: { id: true, name: true, code: true, deletedAt: true },
  });
  const recordById = new Map(records.map((r) => [r.id, r]));
  return users.map((user) => {
    const branchId = branchIdByUser.get(user.id);
    const record = branchId ? recordById.get(branchId) : undefined;
    return {
      id: user.id,
      email: user.email,
      created_at: user.createdAt.toISOString(),
      p64_removed_at: user.deletedAt?.toISOString() ?? null,
      assignment_rows: user.branchAssignments.map((a) => ({
        branch_id: a.branchId,
        removed_at: a.removedAt?.toISOString() ?? null,
      })),
      created_for: branchId
        ? {
            branch_id: branchId,
            name: record?.name ?? null,
            code: record?.code ?? null,
            branch_deleted_at: record?.deletedAt?.toISOString() ?? null,
          }
        : null,
    };
  });
}

export function repairConfirmationToken(manifestText: string, databaseHost: string): string {
  return createHash('sha256')
    .update(`p68-leftover\n${databaseHost}\n${manifestText}`)
    .digest('hex')
    .slice(0, 16);
}

export type LeftoverRepairAction = 'delete' | 'already_deleted' | 'refused';

export interface LeftoverRepairResult {
  id: string;
  action: LeftoverRepairAction;
  refusal: string | null;
  outcome: 'deleted' | 'skipped' | 'would_delete' | 'refused';
}

export interface LeftoverRepairReport {
  mode: 'dry_run' | 'execute';
  confirmation_token: string;
  actor: { id: string; ok: boolean; refusal: string | null };
  accounts: LeftoverRepairResult[];
}

type Client = Pick<typeof prisma, 'user' | 'shift' | 'attendanceRecord'>;

/** Why this manifest entry must not be deleted, or null if it may. Read under the row lock on execution. */
async function refusalFor(
  entry: LeftoverRepairManifest['accounts'][number],
  client: Client,
): Promise<{ missing: boolean; refusal: string | null }> {
  const user = await client.user.findUnique({
    where: { id: entry.id },
    select: {
      role: true,
      email: true,
      branchAssignments: { where: { removedAt: null }, select: { branchId: true } },
    },
  });
  if (!user) return { missing: true, refusal: null };
  if (user.role !== ROLES.BRANCH)
    return { missing: false, refusal: `Not a branch login account (role ${user.role})` };
  if (!user.email || user.email.toLowerCase() !== entry.email.trim().toLowerCase())
    return { missing: false, refusal: 'Email does not match the manifest' };
  if (user.branchAssignments.length > 0)
    return { missing: false, refusal: 'Still assigned to a live branch; it is not a leftover' };
  const [shifts, attendance] = await Promise.all([
    client.shift.count({ where: { cashierId: entry.id, status: 'active' } }),
    client.attendanceRecord.count({
      where: { employeeId: entry.id, clockOutServerTime: null, deletedAt: null },
    }),
  ]);
  if (shifts + attendance > 0) return { missing: false, refusal: 'Has an open shift or clock-in' };
  return { missing: false, refusal: null };
}

export async function runLeftoverRepair(
  manifest: LeftoverRepairManifest,
  options: { execute: boolean; token: string },
): Promise<LeftoverRepairReport> {
  const actor = await prisma.user.findUnique({
    where: { id: manifest.actor_user_id },
    select: { role: true, isActive: true, status: true, deletedAt: true },
  });
  const actorRefusal = !actor
    ? 'Actor not found'
    : actor.role !== ROLES.SUPER_ADMIN ||
        !actor.isActive ||
        actor.status !== 'active' ||
        actor.deletedAt
      ? 'Actor is not an active Super Admin'
      : null;
  const report: LeftoverRepairReport = {
    mode: options.execute ? 'execute' : 'dry_run',
    confirmation_token: options.token,
    actor: { id: manifest.actor_user_id, ok: actorRefusal === null, refusal: actorRefusal },
    accounts: [],
  };

  for (const entry of manifest.accounts) {
    if (!options.execute || actorRefusal) {
      const { missing, refusal } = await refusalFor(entry, prisma);
      report.accounts.push({
        id: entry.id,
        action: missing ? 'already_deleted' : refusal ? 'refused' : 'delete',
        refusal: actorRefusal ?? refusal,
        outcome: missing ? 'skipped' : refusal || actorRefusal ? 'refused' : 'would_delete',
      });
      continue;
    }
    const now = new Date();
    const result = await prisma
      .$transaction(
        async (tx) => {
          // Row lock first, so the checks below see the account as it is deleted.
          const locked = await tx.user.updateMany({
            where: { id: entry.id },
            data: { isActive: false },
          });
          if (locked.count === 0) return { action: 'already_deleted' as const, refusal: null };
          const { refusal } = await refusalFor(entry, tx);
          if (refusal) throw new RepairRefused(refusal);
          await tx.notification.deleteMany({ where: { recipientUserId: entry.id } });
          await tx.expenseIdempotencyKey.deleteMany({ where: { userId: entry.id } });
          const tokenHash = removedAccountRevocationHash(entry.id);
          const expiresAt = new Date(now.getTime() + REMOVED_ACCOUNT_MARKER_TTL_MS);
          await tx.revokedToken.upsert({
            where: { tokenHash },
            create: { tokenHash, expiresAt },
            update: { expiresAt },
          });
          await tx.person.update({
            where: { id: entry.id },
            data: { accountDeletedAt: now, accountDeletedBy: manifest.actor_user_id },
          });
          await tx.user.delete({ where: { id: entry.id } });
          return { action: 'delete' as const, refusal: null };
        },
        { maxWait: 10_000, timeout: 30_000 },
      )
      .catch((error: unknown) => {
        if (error instanceof RepairRefused)
          return { action: 'refused' as const, refusal: error.message };
        throw error;
      });
    report.accounts.push({
      id: entry.id,
      action: result.action,
      refusal: result.refusal,
      outcome:
        result.action === 'delete'
          ? 'deleted'
          : result.action === 'refused'
            ? 'refused'
            : 'skipped',
    });
    if (result.action === 'delete') {
      await recordAuditLog({
        action: 'LEFTOVER_BRANCH_ACCOUNT_DELETED',
        entityType: 'user',
        entityId: entry.id,
        actorId: manifest.actor_user_id,
        actorRole: ROLES.SUPER_ADMIN,
        afterState: {
          deleted: true,
          evidence: entry.evidence,
          procedure: 'p68-leftover-branch-account-repair',
        },
        ipAddress: null,
      });
    }
  }
  return report;
}

class RepairRefused extends Error {}
