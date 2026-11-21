import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ROLES, type JwtPayload } from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';
import { employeesService } from './employees.service.js';
import { employeesRepository, type RemovalPrerequisites } from './employees.repository.js';
import { EmployeeError, type EmployeeHistoryCategory } from './employees.types.js';

/**
 * POS-PERF-P64 — exact-ID cleanup of confirmed E2E / smoke fixture accounts.
 *
 * Nothing here matches names or email substrings: a person reviews each
 * account and lists it in a manifest with its exact id, email, role and the
 * evidence that it is a test fixture. A dry run reports what would happen;
 * the execution re-reads every account, re-checks the manifest still matches
 * it, and goes through the normal employeesService lifecycle as the named
 * Super Admin (same authorization, prerequisites, audit and history
 * retention as the Delete button). Super Admin and Branch accounts are never
 * handled here, and no linked sale, expense, payroll or audit row is changed.
 *
 * POS-PERF-P66 — the lifecycle is now permanent deletion: the account row
 * and its credentials, sessions, PINs and branch access are removed, and the
 * history stays attributed through the person's attribution record. Staff
 * fixtures (which have no email) are identified by exact id, role and full
 * name. Rows that P64 removed but kept are deleted for good the same way.
 */
export const fixtureCleanupManifestSchema = z.object({
  /** The active Super Admin performing (and named in the audit log for) each removal. */
  actor_user_id: z.string().uuid(),
  accounts: z
    .array(
      z.object({
        id: z.string().uuid(),
        /** Exact login email; null for a staff account, which has none. */
        email: z.string().email().nullable(),
        /** Exact full name. Required when email is null (staff), checked whenever given. */
        name: z.string().trim().min(1).optional(),
        role: z.enum(['supervisor', 'staff', 'branch', 'super_admin']),
        /** Why this is a confirmed fixture (e.g. "E2E_SUPERVISOR_EMAIL secret value, created by deploy-production.yml smoke"). */
        evidence: z.string().trim().min(10),
      }),
    )
    .min(1)
    .refine((accounts) => new Set(accounts.map((a) => a.id)).size === accounts.length, 'Duplicate account id')
    .refine((accounts) => accounts.every((a) => a.email !== null || Boolean(a.name)), 'An account without an email needs its exact name'),
});
export type FixtureCleanupManifest = z.infer<typeof fixtureCleanupManifestSchema>;

export type FixturePlannedAction = 'permanent_delete' | 'already_deleted' | 'refused';

export interface FixtureAccountReport {
  id: string;
  email: string | null;
  name: string | null;
  role: string | null;
  status: string | null;
  is_active: boolean | null;
  removed: boolean;
  branches: string[];
  history: Record<EmployeeHistoryCategory, number> | null;
  prerequisites: RemovalPrerequisites | null;
  action: FixturePlannedAction;
  refusal: string | null;
  /** Execution only. */
  outcome?: 'deleted' | 'already_deleted' | 'failed' | 'skipped';
  error?: string;
  /** The account version the confirmation is bound to (read just before acting). */
  version?: string;
}

export interface FixtureCleanupReport {
  mode: 'dry_run' | 'execute';
  /** Ties an execution to the reviewed dry run of the same manifest against the same database. */
  confirmation_token: string;
  actor: { id: string; ok: boolean; refusal: string | null };
  accounts: FixtureAccountReport[];
}

export function confirmationToken(manifestText: string, databaseHost: string): string {
  return createHash('sha256').update(`${databaseHost}\n${manifestText}`).digest('hex').slice(0, 16);
}

async function resolveActor(actorId: string): Promise<{ payload: JwtPayload | null; refusal: string | null }> {
  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { id: true, role: true, email: true, isActive: true, status: true, deletedAt: true },
  });
  if (!actor) return { payload: null, refusal: 'Actor not found' };
  if (actor.role !== ROLES.SUPER_ADMIN) return { payload: null, refusal: 'Actor is not a Super Admin' };
  if (!actor.isActive || actor.status !== 'active' || actor.deletedAt || !actor.email) {
    return { payload: null, refusal: 'Actor is not an active Super Admin' };
  }
  return { payload: { user_id: actor.id, role: 'super_admin', email: actor.email } as JwtPayload, refusal: null };
}

async function evaluate(entry: FixtureCleanupManifest['accounts'][number], actor: JwtPayload | null): Promise<FixtureAccountReport> {
  const user = await employeesRepository.findById(entry.id);
  const base: FixtureAccountReport = {
    id: entry.id,
    email: user?.email ?? null,
    name: user ? `${user.firstName} ${user.lastName}` : null,
    role: user?.role ?? null,
    status: user?.status ?? null,
    is_active: user?.isActive ?? null,
    removed: Boolean(user?.deletedAt),
    branches: user?.branchAssignments.map((a) => a.branch.name) ?? [],
    history: null,
    prerequisites: null,
    action: 'refused',
    refusal: null,
  };
  const refuse = (refusal: string): FixtureAccountReport => ({ ...base, action: 'refused', refusal });

  if (!user) {
    const person = await employeesRepository.findPerson(entry.id);
    if (person?.accountDeletedAt) return { ...base, name: `${person.firstName} ${person.lastName}`, role: person.role, action: 'already_deleted' };
    return refuse('Account not found');
  }
  base.history = await employeesRepository.countHistoryReferences(entry.id);
  // Identity re-check: the manifest must still describe exactly this account.
  if ((user.email ?? '').trim().toLowerCase() !== (entry.email ?? '').trim().toLowerCase()) {
    return refuse('Email does not match the manifest — re-review this account');
  }
  if (entry.name !== undefined && entry.name.trim() !== `${user.firstName} ${user.lastName}`.trim()) {
    return refuse('Name does not match the manifest — re-review this account');
  }
  if (user.role !== entry.role) return refuse('Role does not match the manifest — re-review this account');
  if (user.role === ROLES.SUPER_ADMIN) {
    return refuse('Super Admin fixtures are never removed by this tool — follow the manual Super Admin procedure in the P64 runbook');
  }
  if (user.role === ROLES.BRANCH) return refuse('Branch accounts follow their branch and are not removed here');
  if (!actor) return refuse('No valid Super Admin actor');
  if (actor.user_id === user.id) return refuse('The actor cannot remove their own account');

  let eligibility: Awaited<ReturnType<typeof employeesService.getDeletionEligibility>>;
  try {
    eligibility = await employeesService.getDeletionEligibility(entry.id, actor);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : 'Eligibility check failed');
  }
  base.prerequisites = eligibility.prerequisites;
  if (eligibility.blocked_reason === 'open_operations') {
    return refuse('Open shift, clock-in or unpaid payroll hours — resolve them in the normal workflow first');
  }
  if (!eligibility.can_delete || !eligibility.confirmation) {
    return refuse(`Not deletable (${eligibility.blocked_reason ?? 'unknown'})`);
  }
  return { ...base, action: 'permanent_delete', version: eligibility.confirmation.version };
}

export async function runFixtureCleanup(
  manifest: FixtureCleanupManifest,
  options: { execute: boolean; token: string },
): Promise<FixtureCleanupReport> {
  const actor = await resolveActor(manifest.actor_user_id);
  const accounts: FixtureAccountReport[] = [];
  for (const entry of manifest.accounts) {
    // Evaluated immediately before acting, one account at a time, so an
    // execution never relies on what the dry run saw minutes earlier.
    const report = await evaluate(entry, actor.payload);
    if (options.execute) {
      if (report.action === 'already_deleted') {
        report.outcome = 'already_deleted';
      } else if (report.action === 'refused' || !actor.payload || !report.version || !report.name) {
        report.outcome = 'skipped';
      } else {
        try {
          const result = await employeesService.deleteEmployee(entry.id, actor.payload, null, {
            confirm_name: report.name,
            version: report.version,
          });
          report.outcome = result.outcome;
        } catch (error) {
          report.outcome = 'failed';
          report.error = error instanceof EmployeeError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : 'unknown error';
        }
      }
    }
    accounts.push(report);
  }
  return {
    mode: options.execute ? 'execute' : 'dry_run',
    confirmation_token: options.token,
    actor: { id: manifest.actor_user_id, ok: actor.payload !== null, refusal: actor.refusal },
    accounts,
  };
}
