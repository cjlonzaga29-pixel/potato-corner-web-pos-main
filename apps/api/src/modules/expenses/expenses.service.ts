import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ROLES, SOCKET_EVENTS, expenseDisplayName, legacyExpenseCategoryLabel, type ExpenseListQuery, type ExpenseSummaryQuery, type ExpenseSummaryResponse, type JwtPayload } from '@potato-corner/shared';
import { expensesRepository } from './expenses.repository.js';
import { expenseTypesRepository } from '../expense-types/expense-types.repository.js';
import { ExpenseError, type CreateExpenseData, type UpdateExpenseData } from './expenses.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { getAccessibleBranchIds, assertBranchAccess } from '../../lib/branch-access.js';
import { notifyBranch, notifySuperAdmin } from '../../lib/notify.js';
import { manilaDateStringToUtc } from '../../lib/manila-time.js';
import { enqueueNotification } from '../../queues/notification.queue.js';

type ActorContext = { id: string; role: string };

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

interface ExpenseRow {
  id: string;
  branchId: string;
  category: string;
  expenseTypeId: string | null;
  expenseTypeName: string | null;
  expenseType: { id: string; name: string; isActive: boolean } | null;
  amount: { toNumber(): number };
  vendorName: string | null;
  description: string | null;
  receiptUrl: string | null;
  receiptKey: string | null;
  incurredAt: Date;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  branch: { id: string; name: string };
  creator: { id: string; firstName: string; lastName: string };
}

async function getSignedReceiptUrl(receiptKey: string): Promise<string> {
  const { data, error } = await supabaseAdmin.storage.from('expense-receipts').createSignedUrl(receiptKey, 60 * 60);
  if (error || !data) throw new ExpenseError('RECEIPT_URL_FAILED', 'Could not generate receipt URL', 500);
  return data.signedUrl;
}

async function toResponse(row: ExpenseRow) {
  return {
    id: row.id,
    branch_id: row.branchId,
    branch_name: row.branch.name,
    category: row.category,
    expense_type_id: row.expenseTypeId,
    expense_type_name: row.expenseTypeName,
    expense_type_current_name: row.expenseType?.name ?? null,
    expense_type_is_active: row.expenseType?.isActive ?? null,
    amount: row.amount.toNumber(),
    vendor_name: row.vendorName,
    description: row.description,
    receipt_url: row.receiptKey ? await getSignedReceiptUrl(row.receiptKey) : null,
    incurred_at: row.incurredAt.toISOString(),
    created_by: row.createdBy,
    created_by_name: `${row.creator.firstName} ${row.creator.lastName}`,
    created_at: row.createdAt.toISOString(),
  };
}

interface CreateExpenseInput {
  branch_id: string;
  category?: string;
  expense_type_id?: string;
  amount: number;
  vendor_name?: string;
  description?: string;
  incurred_at: string;
}

type UpdateExpenseInput = Partial<CreateExpenseInput>;

/** What a retry of the same submission must match. Key order is fixed here, so equal submissions hash equally. */
function requestHash(data: CreateExpenseInput): string {
  const fields = [data.branch_id, data.category ?? null, data.expense_type_id ?? null, data.amount.toFixed(2), data.vendor_name ?? null, data.description ?? null, data.incurred_at];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

const keyReused = () =>
  new ExpenseError('EXPENSE_KEY_REUSED', 'An earlier attempt of this form may already have saved an expense with different details. Check the ledger, then start a new expense if it is missing.', 409);

/** Reads every caller's branches live. An explicit branch outside them is refused, never quietly widened or emptied. */
async function resolveLedgerScope(actor: JwtPayload, branchId: string | undefined) {
  if (branchId) await assertBranchAccess(actor, branchId, ExpenseError);
  return getAccessibleBranchIds(actor);
}

export const expensesService = {
  async getExpenses(actor: JwtPayload, query: ExpenseListQuery) {
    const branchIds = await resolveLedgerScope(actor, query.branch_id);
    const { date_from: dateFrom, date_to: dateTo, ...filters } = query;
    const { expenses, total, totalAmount } = await expensesRepository.findAll({ ...filters, dateFrom, dateTo, branchIds });
    return {
      expenses: await Promise.all((expenses as ExpenseRow[]).map(toResponse)),
      total,
      total_amount: totalAmount,
      page: filters.page,
      limit: filters.limit,
    };
  },

  /** A deactivated type stays on its line, and an expense of a type outside the caller's scope is still named. */
  async getSummary(actor: JwtPayload, query: ExpenseSummaryQuery): Promise<ExpenseSummaryResponse> {
    const branchIds = await resolveLedgerScope(actor, query.branch_id);
    const { date_from: dateFrom, date_to: dateTo, ...filters } = query;
    const rows = await expensesRepository.summarize({ ...filters, dateFrom, dateTo, branchIds });
    const typeIds = rows.flatMap((row) => (row.expenseTypeId ? [row.expenseTypeId] : []));
    const types = typeIds.length > 0 ? await expenseTypesRepository.findNames(typeIds) : [];
    const groups = rows
      .map((row) => {
        const type = types.find((t) => t.id === row.expenseTypeId);
        return {
          key: row.key,
          kind: row.expenseTypeId ? ('type' as const) : ('legacy' as const),
          expense_type_id: row.expenseTypeId,
          category: row.category,
          name: row.expenseTypeId ? (type?.name ?? 'Unknown type') : legacyExpenseCategoryLabel(row.category ?? ''),
          is_active: row.expenseTypeId ? (type?.isActive ?? false) : null,
          count: row.count,
          total_amount: row.amount,
        };
      })
      .sort((a, b) => b.total_amount - a.total_amount || a.name.localeCompare(b.name));
    const cents = groups.reduce((sum, group) => sum + Math.round(group.total_amount * 100), 0);
    return { total: groups.reduce((sum, group) => sum + group.count, 0), total_amount: cents / 100, groups };
  },

  async getExpense(id: string, actor: JwtPayload) {
    const expense = (await expensesRepository.findById(id)) as ExpenseRow | null;
    if (!expense) throw new ExpenseError('EXPENSE_NOT_FOUND', 'Expense not found', 404);
    await assertBranchAccess(actor, expense.branchId, ExpenseError);
    return expense;
  },

  async getExpenseResponse(id: string, actor: JwtPayload) {
    const expense = await expensesService.getExpense(id, actor);
    return toResponse(expense);
  },

  async createExpense(data: CreateExpenseInput, actor: JwtPayload, ipAddress: string | null, idempotencyKey?: string) {
    // First, so a revoked assignment can't read an earlier result back through a replay.
    await assertBranchAccess(actor, data.branch_id, ExpenseError);

    const createData: CreateExpenseData = {
      branchId: data.branch_id,
      // The shared schema requires one of the two. Old clients record a legacy expense
      // here, under the category they chose; the repository stores the placeholder for a typed one.
      category: data.category ?? '',
      amount: data.amount,
      vendorName: data.vendor_name,
      description: data.description,
      incurredAt: manilaDateStringToUtc(data.incurred_at),
    };

    const hash = idempotencyKey ? requestHash(data) : null;
    const outcome = await expensesRepository.create(
      createData,
      actor.user_id,
      data.expense_type_id,
      idempotencyKey && hash ? { key: idempotencyKey, userId: actor.user_id, requestHash: hash } : null,
    );

    if (!outcome.created) {
      const prior = outcome.replayOf;
      // Rows an older API wrote carry no hash: a matching user and key is all there is to compare.
      if (!prior || prior.userId !== actor.user_id || (prior.requestHash && prior.requestHash !== hash)) throw keyReused();
      const existing = prior.expenseId ? ((await expensesRepository.findById(prior.expenseId)) as ExpenseRow | null) : null;
      if (!existing) throw keyReused();
      return toResponse(existing);
    }

    const created = outcome.created as ExpenseRow;
    const response = await toResponse(created);

    await recordAuditLog({
      action: 'EXPENSE_CREATED',
      entityType: 'expense',
      entityId: created.id,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: data.branch_id,
      afterState: response,
      ipAddress,
    });

    notifyBranch(data.branch_id, SOCKET_EVENTS.EXPENSE_CREATED, response);
    notifySuperAdmin(SOCKET_EVENTS.EXPENSE_CREATED, response);

    try {
      await enqueueNotification('expense_created', {
        type: 'expense_created',
        branchId: data.branch_id,
        expenseId: created.id,
        category: expenseDisplayName(response),
        amount: response.amount,
        vendorName: response.vendor_name ?? null,
        createdByName: response.created_by_name,
      });
    } catch (error) {
      console.error(`Failed to enqueue expense-created notification for expense ${created.id}:`, error);
    }

    return response;
  },

  async updateExpense(id: string, data: UpdateExpenseInput, actor: JwtPayload, ipAddress: string | null) {
    const existing = await expensesService.getExpense(id, actor);
    const before = await toResponse(existing);

    const targetBranchId = data.branch_id ?? existing.branchId;
    if (targetBranchId !== existing.branchId) await assertBranchAccess(actor, targetBranchId, ExpenseError);

    // A typed expense's category is a placeholder. An older form resends it unchanged, which is harmless; changing it means nothing.
    if (existing.expenseTypeId && data.category && data.category !== existing.category) {
      throw new ExpenseError('EXPENSE_CATEGORY_NOT_EDITABLE', 'This expense uses an expense type, not a category. Reload to see it.', 409);
    }

    const newTypeId = data.expense_type_id && data.expense_type_id !== existing.expenseTypeId ? data.expense_type_id : null;
    const typeToCheck = newTypeId ?? (targetBranchId !== existing.branchId ? existing.expenseTypeId : null);

    const updateData: UpdateExpenseData = {
      ...(data.branch_id && { branchId: data.branch_id }),
      ...(data.category && { category: data.category }),
      ...(data.amount !== undefined && { amount: data.amount }),
      ...(data.vendor_name !== undefined && { vendorName: data.vendor_name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.incurred_at && { incurredAt: manilaDateStringToUtc(data.incurred_at) }),
    };

    const updated = (await expensesRepository.update(
      id,
      updateData,
      // Unchanged type and branch aren't re-checked: a deactivated type's history stays editable, and its recorded name stays.
      typeToCheck ? { expenseTypeId: typeToCheck, branchId: targetBranchId, recordName: Boolean(newTypeId) } : undefined,
    )) as ExpenseRow;
    const response = await toResponse(updated);

    await recordAuditLog({
      action: 'EXPENSE_UPDATED',
      entityType: 'expense',
      entityId: id,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: existing.branchId,
      beforeState: before,
      afterState: response,
      ipAddress,
    });

    notifyBranch(existing.branchId, SOCKET_EVENTS.EXPENSE_UPDATED, response);
    notifySuperAdmin(SOCKET_EVENTS.EXPENSE_UPDATED, response);

    return response;
  },

  async deleteExpense(id: string, actor: ActorContext, ipAddress: string | null) {
    if (actor.role !== ROLES.SUPER_ADMIN) {
      throw new ExpenseError('FORBIDDEN', 'Only super_admin may delete expenses', 403);
    }

    const existing = (await expensesRepository.findById(id)) as ExpenseRow | null;
    if (!existing) throw new ExpenseError('EXPENSE_NOT_FOUND', 'Expense not found', 404);

    await expensesRepository.softDelete(id);

    await recordAuditLog({
      action: 'EXPENSE_DELETED',
      entityType: 'expense',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: existing.branchId,
      beforeState: await toResponse(existing),
      ipAddress,
    });

    notifyBranch(existing.branchId, SOCKET_EVENTS.EXPENSE_DELETED, { id });
    notifySuperAdmin(SOCKET_EVENTS.EXPENSE_DELETED, { id });
  },

  async uploadReceipt(id: string, file: { buffer: Buffer; originalname: string }, actor: JwtPayload, ipAddress: string | null) {
    const existing = await expensesService.getExpense(id, actor);

    if (existing.receiptKey) {
      const { error: removeError } = await supabaseAdmin.storage.from('expense-receipts').remove([existing.receiptKey]);
      if (removeError) {
        console.error('Failed to remove old receipt object:', removeError);
      }
    }

    const compressed = await sharp(file.buffer)
      .resize({ width: 1200, withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    const path = `expenses/${id}/${Date.now()}-${sanitizeFilename(file.originalname)}.webp`;
    const { error } = await supabaseAdmin.storage
      .from('expense-receipts')
      .upload(path, compressed, { contentType: 'image/webp', upsert: true });
    if (error) {
      throw new ExpenseError('RECEIPT_UPLOAD_FAILED', 'Failed to upload the receipt image', 502);
    }

    const signedUrl = await getSignedReceiptUrl(path);

    const updated = (await expensesRepository.updateReceipt(id, signedUrl, path)) as ExpenseRow;
    const response = await toResponse(updated);

    await recordAuditLog({
      action: 'EXPENSE_RECEIPT_UPLOADED',
      entityType: 'expense',
      entityId: id,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: existing.branchId,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async deleteReceipt(id: string, actor: JwtPayload, ipAddress: string | null) {
    const existing = await expensesService.getExpense(id, actor);

    if (!existing.receiptKey) {
      throw new ExpenseError('NO_RECEIPT', 'This expense has no receipt to delete', 404);
    }

    const { error } = await supabaseAdmin.storage.from('expense-receipts').remove([existing.receiptKey]);
    if (error) {
      throw new ExpenseError('RECEIPT_DELETE_FAILED', 'Failed to delete the receipt image', 502);
    }

    const updated = (await expensesRepository.updateReceipt(id, null, null)) as ExpenseRow;
    const response = await toResponse(updated);

    await recordAuditLog({
      action: 'EXPENSE_RECEIPT_DELETED',
      entityType: 'expense',
      entityId: id,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: existing.branchId,
      beforeState: { receiptKey: existing.receiptKey, receiptUrl: existing.receiptUrl },
      ipAddress,
    });

    return response;
  },
};
