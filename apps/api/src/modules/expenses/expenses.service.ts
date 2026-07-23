import sharp from 'sharp';
import { ROLES, SOCKET_EVENTS, type JwtPayload } from '@potato-corner/shared';
import { expensesRepository } from './expenses.repository.js';
import { ExpenseError, type CreateExpenseData, type ExpenseFilters, type UpdateExpenseData } from './expenses.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { getAccessibleBranchIds, assertBranchAccess } from '../../lib/branch-access.js';
import { notifyBranch, notifySuperAdmin } from '../../lib/notify.js';

type ActorContext = { id: string; role: string };

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

interface ExpenseRow {
  id: string;
  branchId: string;
  category: string;
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
  category: string;
  amount: number;
  vendor_name?: string;
  description?: string;
  incurred_at: string;
}

type UpdateExpenseInput = Partial<CreateExpenseInput>;

export const expensesService = {
  async getExpenses(actor: JwtPayload, filters: Omit<ExpenseFilters, 'branchIds'>) {
    const branchIds = getAccessibleBranchIds(actor);
    const { expenses, total, totalAmount } = await expensesRepository.findAll({ ...filters, branchIds });
    return {
      expenses: await Promise.all((expenses as ExpenseRow[]).map(toResponse)),
      total,
      total_amount: totalAmount,
      page: filters.page,
      limit: filters.limit,
    };
  },

  async getExpense(id: string, actor: JwtPayload) {
    const expense = (await expensesRepository.findById(id)) as ExpenseRow | null;
    if (!expense) throw new ExpenseError('EXPENSE_NOT_FOUND', 'Expense not found', 404);
    assertBranchAccess(actor, expense.branchId, ExpenseError);
    return expense;
  },

  async getExpenseResponse(id: string, actor: JwtPayload) {
    const expense = await expensesService.getExpense(id, actor);
    return toResponse(expense);
  },

  async createExpense(data: CreateExpenseInput, actor: JwtPayload, ipAddress: string | null, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existingKey = await expensesRepository.findIdempotencyKey(idempotencyKey, actor.user_id);
      if (existingKey?.expenseId) {
        const existing = (await expensesRepository.findById(existingKey.expenseId)) as ExpenseRow | null;
        if (existing) return await toResponse(existing);
      }
    }

    assertBranchAccess(actor, data.branch_id, ExpenseError);

    const createData: CreateExpenseData = {
      branchId: data.branch_id,
      category: data.category,
      amount: data.amount,
      vendorName: data.vendor_name,
      description: data.description,
      incurredAt: new Date(data.incurred_at),
    };

    const created = (await expensesRepository.create(createData, actor.user_id)) as ExpenseRow;
    const response = await toResponse(created);

    if (idempotencyKey) {
      await expensesRepository.recordIdempotencyKey(idempotencyKey, actor.user_id, created.id);
    }

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

    return response;
  },

  async updateExpense(id: string, data: UpdateExpenseInput, actor: JwtPayload, ipAddress: string | null) {
    const existing = await expensesService.getExpense(id, actor);
    const before = await toResponse(existing);

    const updateData: UpdateExpenseData = {
      ...(data.branch_id && { branchId: data.branch_id }),
      ...(data.category && { category: data.category }),
      ...(data.amount !== undefined && { amount: data.amount }),
      ...(data.vendor_name !== undefined && { vendorName: data.vendor_name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.incurred_at && { incurredAt: new Date(data.incurred_at) }),
    };

    const updated = (await expensesRepository.update(id, updateData)) as ExpenseRow;
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
