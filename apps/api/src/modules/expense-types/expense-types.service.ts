import { Prisma } from '@prisma/client';
import {
  ROLES,
  normalizeExpenseTypeName,
  type CreateExpenseTypeInput,
  type ExpenseTypeListQuery,
  type ExpenseTypeResponse,
  type JwtPayload,
  type UpdateExpenseTypeInput,
} from '@potato-corner/shared';
import { z } from 'zod';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { getAccessibleBranchIds, hasBranchAccess } from '../../lib/branch-access.js';
import { branchesRepository } from '../branches/branches.repository.js';
import { expenseTypesRepository, type ExpenseTypeRow } from './expense-types.repository.js';
import { ExpenseTypeError } from './expense-types.types.js';

type ActorContext = { id: string; role: string };
type Client = Prisma.TransactionClient;

function toResponse(row: ExpenseTypeRow, liveBranchIds: 'all' | string[], expenseCount: number, role: string): ExpenseTypeResponse {
  const visible = row.branches.filter((b) => liveBranchIds === 'all' || liveBranchIds.includes(b.branchId));
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    is_active: row.isActive,
    version: row.version,
    branches: visible.map((b) => ({ branch_id: b.branchId, branch_name: b.branch.name })).sort((a, b) => a.branch_name.localeCompare(b.branch_name)),
    other_branch_count: row.branches.length - visible.length,
    can_manage: role === ROLES.SUPERVISOR && row.branches.length > 0 && row.branches.length === visible.length,
    expense_count: expenseCount,
  };
}

function isNameCollision(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

const nameTaken = (name: string) => new ExpenseTypeError('EXPENSE_TYPE_NAME_TAKEN', `An active expense type named "${name}" already exists at one of these branches.`, 409);
const conflict = () =>
  new ExpenseTypeError('EXPENSE_TYPE_CONFLICT', 'This expense type was changed by someone else since you loaded it. Reload to see the latest version before saving again.', 409);

/**
 * The type as its manager may act on it. Overlap lets a supervisor see and use a
 * type, but only covering its whole scope lets them change it, as with a product
 * type. Assignments are read live, never from the JWT, so a revoked one stops
 * working at once.
 */
async function loadManageable(expenseTypeId: string, actor: ActorContext, client?: Client) {
  const notFound = new ExpenseTypeError('EXPENSE_TYPE_NOT_FOUND', 'Expense type not found', 404);
  if (!z.uuid().safeParse(expenseTypeId).success) throw notFound;
  const row = await expenseTypesRepository.findById(expenseTypeId, client);
  if (!row) throw notFound;
  const liveBranchIds = await branchesRepository.findAllActiveBranchIds(actor.id, client);
  if (!row.branches.some((b) => liveBranchIds.includes(b.branchId))) throw notFound;
  if (!row.branches.every((b) => liveBranchIds.includes(b.branchId))) {
    throw new ExpenseTypeError('EXPENSE_TYPE_SCOPE_FORBIDDEN', 'This expense type is shared with a branch outside your assignment, so you can use it but not change it.', 403);
  }
  return { row, liveBranchIds };
}

async function assertBranchesAssignable(branchIds: string[], liveBranchIds: string[], client: Client): Promise<void> {
  const active = await expenseTypesRepository.findActiveBranchIds(branchIds, client);
  if (active.length !== branchIds.length) {
    throw new ExpenseTypeError('BRANCH_SELECTION_INVALID', 'One or more selected branches do not exist or are inactive', 422);
  }
  if (!branchIds.every((id) => liveBranchIds.includes(id))) {
    throw new ExpenseTypeError('BRANCH_ACCESS_DENIED', 'You do not have an active assignment to every selected branch', 403);
  }
}

export const expenseTypesService = {
  async list(user: JwtPayload, filters: ExpenseTypeListQuery) {
    if (filters.branch_id && !(await hasBranchAccess(user, filters.branch_id))) {
      throw new ExpenseTypeError('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
    }
    const accessible = await getAccessibleBranchIds(user);
    const rows = await expenseTypesRepository.findMany({
      includeInactive: filters.include_inactive,
      ...(filters.branch_id ? { branchIds: [filters.branch_id] } : accessible !== 'all' ? { branchIds: accessible } : {}),
    });
    const counts = await expenseTypesRepository.countExpensesByType(rows.map((row) => row.id), accessible);
    return { types: rows.map((row) => toResponse(row, accessible, counts.get(row.id) ?? 0, user.role)) };
  },

  async create(data: CreateExpenseTypeInput, actor: ActorContext, ipAddress: string | null) {
    const branchIds = [...new Set(data.branch_ids)];
    let saved;
    try {
      saved = await expenseTypesRepository.transaction(async (tx) => {
        const liveBranchIds = await branchesRepository.findAllActiveBranchIds(actor.id, tx);
        await assertBranchesAssignable(branchIds, liveBranchIds, tx);
        const row = await expenseTypesRepository.create(
          { name: data.name, normalizedName: normalizeExpenseTypeName(data.name), description: data.description || null, createdById: actor.id },
          branchIds,
          tx,
        );
        return { row, liveBranchIds };
      });
    } catch (error) {
      if (isNameCollision(error)) throw nameTaken(data.name);
      throw error;
    }

    const response = toResponse(saved.row, saved.liveBranchIds, 0, actor.role);
    await recordAuditLog({ action: 'EXPENSE_TYPE_CREATED', entityType: 'expense_type', entityId: saved.row.id, actorId: actor.id, actorRole: actor.role, afterState: response, ipAddress });
    return response;
  },

  /**
   * The scope rule: branches can always be added. A branch can be removed only while
   * no expense at that branch has ever used this type, so a scope edit can't hide
   * history; deactivate the type or create a narrower one otherwise. The check runs
   * after this transaction holds the type's row, and recording an expense takes the
   * same row (lockUsable), so neither can slip past the other.
   */
  async update(expenseTypeId: string, data: UpdateExpenseTypeInput, actor: ActorContext, ipAddress: string | null) {
    let saved;
    try {
      saved = await expenseTypesRepository.transaction(async (tx) => {
        const { row: unlocked, liveBranchIds } = await loadManageable(expenseTypeId, actor, tx);
        const swapped = await expenseTypesRepository.compareAndUpdate(
          expenseTypeId,
          {
            ...(data.name !== undefined && { name: data.name, normalizedName: normalizeExpenseTypeName(data.name) }),
            ...(data.description !== undefined && { description: data.description || null }),
            updatedById: actor.id,
          },
          data.expected_version,
          tx,
        );
        if (!swapped) throw conflict();

        const scope = await expenseTypesRepository.findById(expenseTypeId, tx);
        const current = (scope ?? unlocked).branches.map((b) => b.branchId);
        const next = data.branch_ids ? [...new Set(data.branch_ids)] : current;
        const added = next.filter((id) => !current.includes(id));
        const removed = current.filter((id) => !next.includes(id));
        if (added.length > 0) await assertBranchesAssignable(added, liveBranchIds, tx);
        if (removed.length > 0) {
          const inUse = await expenseTypesRepository.countExpensesAtBranches(expenseTypeId, removed, tx);
          if (inUse.length > 0) {
            const names = unlocked.branches.filter((b) => inUse.some((use) => use.branchId === b.branchId)).map((b) => b.branch.name);
            throw new ExpenseTypeError(
              'EXPENSE_TYPE_SCOPE_IN_USE',
              `${names.join(', ')} already recorded expenses of this type, so it can't be removed. Deactivate the type or create a new one for a smaller set of branches.`,
              422,
            );
          }
        }
        await expenseTypesRepository.replaceScope(expenseTypeId, added, removed, tx);

        const row = await expenseTypesRepository.findById(expenseTypeId, tx);
        const counts = await expenseTypesRepository.countExpensesByType([expenseTypeId], liveBranchIds, tx);
        return { before: unlocked, row: row as ExpenseTypeRow, liveBranchIds, count: counts.get(expenseTypeId) ?? 0, scopeChanged: added.length + removed.length > 0 };
      });
    } catch (error) {
      if (isNameCollision(error)) throw nameTaken(data.name ?? 'this name');
      throw error;
    }

    const response = toResponse(saved.row, saved.liveBranchIds, saved.count, actor.role);
    await recordAuditLog({
      action: saved.scopeChanged ? 'EXPENSE_TYPE_SCOPE_CHANGED' : 'EXPENSE_TYPE_UPDATED',
      entityType: 'expense_type',
      entityId: expenseTypeId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toResponse(saved.before, saved.liveBranchIds, saved.count, actor.role),
      afterState: response,
      ipAddress,
    });
    return response;
  },

  /** Stops new use and nothing else. Reactivating refuses a name another active type now holds. */
  async setActive(expenseTypeId: string, isActive: boolean, expectedVersion: number, actor: ActorContext, ipAddress: string | null) {
    const { row: before, liveBranchIds } = await loadManageable(expenseTypeId, actor);
    const counts = await expenseTypesRepository.countExpensesByType([before.id], liveBranchIds);
    const expenseCount = counts.get(before.id) ?? 0;
    // A retry of a change that already happened.
    if (before.isActive === isActive) return toResponse(before, liveBranchIds, expenseCount, actor.role);

    let row;
    try {
      row = await expenseTypesRepository.setActive(expenseTypeId, isActive, expectedVersion, actor.id);
    } catch (error) {
      if (isNameCollision(error)) throw nameTaken(before.name);
      throw error;
    }
    if (!row) throw conflict();

    const response = toResponse(row, liveBranchIds, expenseCount, actor.role);
    await recordAuditLog({
      action: isActive ? 'EXPENSE_TYPE_REACTIVATED' : 'EXPENSE_TYPE_DEACTIVATED',
      entityType: 'expense_type',
      entityId: row.id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: { is_active: before.isActive },
      afterState: { is_active: row.isActive, expense_count: expenseCount },
      ipAddress,
    });
    return response;
  },
};
