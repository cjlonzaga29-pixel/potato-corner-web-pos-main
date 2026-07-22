import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ROLES } from '@potato-corner/shared';

vi.mock('./expenses.repository.js', () => ({
  expensesRepository: {
    findAll: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateReceipt: vi.fn(),
    softDelete: vi.fn(),
    findIdempotencyKey: vi.fn(),
    recordIdempotencyKey: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const storageMock = {
  upload: vi.fn().mockResolvedValue({ error: null }),
  createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://example.com/receipt.webp' }, error: null }),
  remove: vi.fn().mockResolvedValue({ error: null }),
};

vi.mock('../../lib/supabase.js', () => ({
  supabaseAdmin: {
    storage: {
      from: vi.fn(() => storageMock),
    },
  },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-image')),
  })),
}));

const { expensesRepository } = await import('./expenses.repository.js');
const { expensesService } = await import('./expenses.service.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');

const SUPER_ADMIN_JWT = {
  user_id: 'admin-1',
  role: ROLES.SUPER_ADMIN as typeof ROLES.SUPER_ADMIN,
  email: 'admin@test.com',
  iat: 0,
  exp: 0,
};
const SUPERVISOR_JWT = {
  user_id: 'sup-1',
  role: ROLES.SUPERVISOR as typeof ROLES.SUPERVISOR,
  email: 'sup@test.com',
  branch_ids: ['branch-a'],
  iat: 0,
  exp: 0,
};

function buildExpenseRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'expense-1',
    branchId: 'branch-a',
    category: 'utilities',
    amount: { toNumber: () => 1500 },
    vendorName: 'Meralco',
    description: 'Electric bill',
    receiptUrl: null,
    receiptKey: null,
    incurredAt: new Date('2026-07-01T00:00:00.000Z'),
    createdBy: 'sup-1',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    deletedAt: null,
    branch: { id: 'branch-a', name: 'Main' },
    creator: { id: 'sup-1', firstName: 'Sup', lastName: 'Visor' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('expensesService.createExpense', () => {
  it('happy path creates the expense and records an audit log', async () => {
    vi.mocked(expensesRepository.create).mockResolvedValue(buildExpenseRow() as never);

    const result = await expensesService.createExpense(
      { branch_id: 'branch-a', category: 'utilities', amount: 1500, incurred_at: '2026-07-01T00:00:00.000Z' },
      SUPERVISOR_JWT,
      null,
    );

    expect(result.amount).toBe(1500);
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'EXPENSE_CREATED' }));
  });

  it('idempotency key returns the existing expense on a duplicate submission', async () => {
    vi.mocked(expensesRepository.findIdempotencyKey).mockResolvedValue({
      id: 'key-1',
      key: 'dup-key',
      userId: 'sup-1',
      expenseId: 'expense-1',
      createdAt: new Date(),
    } as never);
    vi.mocked(expensesRepository.findById).mockResolvedValue(buildExpenseRow() as never);

    const result = await expensesService.createExpense(
      { branch_id: 'branch-a', category: 'utilities', amount: 1500, incurred_at: '2026-07-01T00:00:00.000Z' },
      SUPERVISOR_JWT,
      null,
      'dup-key',
    );

    expect(result.id).toBe('expense-1');
    expect(expensesRepository.create).not.toHaveBeenCalled();
  });

  it('supervisor without access to the branch throws 403', async () => {
    await expect(
      expensesService.createExpense(
        { branch_id: 'branch-z', category: 'utilities', amount: 1500, incurred_at: '2026-07-01T00:00:00.000Z' },
        SUPERVISOR_JWT,
        null,
      ),
    ).rejects.toMatchObject({ code: 'BRANCH_ACCESS_DENIED', statusCode: 403 });

    expect(expensesRepository.create).not.toHaveBeenCalled();
  });
});

describe('expensesService.updateExpense', () => {
  it('records an audit log with before and after state', async () => {
    vi.mocked(expensesRepository.findById).mockResolvedValue(buildExpenseRow() as never);
    vi.mocked(expensesRepository.update).mockResolvedValue(buildExpenseRow({ amount: { toNumber: () => 2000 } }) as never);

    const result = await expensesService.updateExpense('expense-1', { amount: 2000 }, SUPERVISOR_JWT, null);

    expect(result.amount).toBe(2000);
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'EXPENSE_UPDATED',
        beforeState: expect.objectContaining({ amount: 1500 }),
        afterState: expect.objectContaining({ amount: 2000 }),
      }),
    );
  });
});

describe('expensesService.deleteExpense', () => {
  it('super_admin can delete, audit log includes the full snapshot', async () => {
    vi.mocked(expensesRepository.findById).mockResolvedValue(buildExpenseRow() as never);

    await expensesService.deleteExpense('expense-1', { id: 'admin-1', role: ROLES.SUPER_ADMIN }, null);

    expect(expensesRepository.softDelete).toHaveBeenCalledWith('expense-1');
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'EXPENSE_DELETED', beforeState: expect.objectContaining({ id: 'expense-1' }) }),
    );
  });

  it('CRITICAL: supervisor role throws 403 — only super_admin may delete expenses', async () => {
    await expect(
      expensesService.deleteExpense('expense-1', { id: 'sup-1', role: ROLES.SUPERVISOR }, null),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

    expect(expensesRepository.softDelete).not.toHaveBeenCalled();
  });
});

describe('expensesService.uploadReceipt', () => {
  it('removes the old storage object before uploading a new one when a receiptKey already exists', async () => {
    vi.mocked(expensesRepository.findById).mockResolvedValue(
      buildExpenseRow({ receiptKey: 'expenses/expense-1/old.webp', receiptUrl: 'https://example.com/old.webp' }) as never,
    );
    vi.mocked(expensesRepository.updateReceipt).mockResolvedValue(
      buildExpenseRow({ receiptKey: 'expenses/expense-1/new.webp', receiptUrl: 'https://example.com/new.webp' }) as never,
    );

    await expensesService.uploadReceipt('expense-1', { buffer: Buffer.from('img'), originalname: 'receipt.jpg' }, SUPERVISOR_JWT, null);

    expect(storageMock.remove).toHaveBeenCalledWith(['expenses/expense-1/old.webp']);
  });

  it('skips the remove call when no receiptKey exists yet', async () => {
    vi.mocked(expensesRepository.findById).mockResolvedValue(buildExpenseRow({ receiptKey: null }) as never);
    vi.mocked(expensesRepository.updateReceipt).mockResolvedValue(
      buildExpenseRow({ receiptKey: 'expenses/expense-1/new.webp', receiptUrl: 'https://example.com/new.webp' }) as never,
    );

    await expensesService.uploadReceipt('expense-1', { buffer: Buffer.from('img'), originalname: 'receipt.jpg' }, SUPERVISOR_JWT, null);

    expect(storageMock.remove).not.toHaveBeenCalled();
  });
});

describe('expensesService.deleteReceipt', () => {
  it('happy path removes the storage object, clears the fields, and records an audit log', async () => {
    vi.mocked(expensesRepository.findById).mockResolvedValue(
      buildExpenseRow({ receiptKey: 'expenses/expense-1/old.webp', receiptUrl: 'https://example.com/old.webp' }) as never,
    );
    vi.mocked(expensesRepository.updateReceipt).mockResolvedValue(
      buildExpenseRow({ receiptKey: null, receiptUrl: null }) as never,
    );

    const result = await expensesService.deleteReceipt('expense-1', SUPERVISOR_JWT, null);

    expect(storageMock.remove).toHaveBeenCalledWith(['expenses/expense-1/old.webp']);
    expect(expensesRepository.updateReceipt).toHaveBeenCalledWith('expense-1', null, null);
    expect(result.receipt_url).toBeNull();
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'EXPENSE_RECEIPT_DELETED',
        beforeState: { receiptKey: 'expenses/expense-1/old.webp', receiptUrl: 'https://example.com/old.webp' },
      }),
    );
  });

  it('throws 404 when the expense has no receipt', async () => {
    vi.mocked(expensesRepository.findById).mockResolvedValue(buildExpenseRow({ receiptKey: null }) as never);

    await expect(expensesService.deleteReceipt('expense-1', SUPERVISOR_JWT, null)).rejects.toMatchObject({
      code: 'NO_RECEIPT',
      statusCode: 404,
    });
    expect(expensesRepository.updateReceipt).not.toHaveBeenCalled();
  });

  it('supervisor without branch access throws 403', async () => {
    vi.mocked(expensesRepository.findById).mockResolvedValue(
      buildExpenseRow({ branchId: 'branch-z', receiptKey: 'expenses/expense-1/old.webp' }) as never,
    );

    await expect(expensesService.deleteReceipt('expense-1', SUPERVISOR_JWT, null)).rejects.toMatchObject({
      code: 'BRANCH_ACCESS_DENIED',
      statusCode: 403,
    });
    expect(expensesRepository.updateReceipt).not.toHaveBeenCalled();
  });
});

describe('expensesService.getExpenses', () => {
  it('scopes the query by the actor accessibleBranchIds', async () => {
    vi.mocked(expensesRepository.findAll).mockResolvedValue({ expenses: [], total: 0, totalAmount: 0 } as never);

    await expensesService.getExpenses(SUPERVISOR_JWT, { page: 1, limit: 25 });

    expect(expensesRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ branchIds: ['branch-a'] }));
  });

  it('super_admin is scoped to all branches', async () => {
    vi.mocked(expensesRepository.findAll).mockResolvedValue({ expenses: [], total: 0, totalAmount: 0 } as never);

    await expensesService.getExpenses(SUPER_ADMIN_JWT, { page: 1, limit: 25 });

    expect(expensesRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ branchIds: 'all' }));
  });
});

describe('expensesService.getExpense', () => {
  it('throws 403 when accessing an expense in a branch the actor is not assigned to', async () => {
    vi.mocked(expensesRepository.findById).mockResolvedValue(buildExpenseRow({ branchId: 'branch-z' }) as never);

    await expect(expensesService.getExpense('expense-1', SUPERVISOR_JWT)).rejects.toMatchObject({
      code: 'BRANCH_ACCESS_DENIED',
      statusCode: 403,
    });
  });

  it('throws 404 when the expense does not exist', async () => {
    vi.mocked(expensesRepository.findById).mockResolvedValue(null as never);

    await expect(expensesService.getExpense('missing', SUPERVISOR_JWT)).rejects.toMatchObject({ code: 'EXPENSE_NOT_FOUND', statusCode: 404 });
  });
});
