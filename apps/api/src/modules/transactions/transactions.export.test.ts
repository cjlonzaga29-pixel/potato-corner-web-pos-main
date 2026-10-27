import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * POS-PERF-P40 — transactionsService.exportTransactionsPdf rules that the
 * real-Postgres suite can't reach locally (the local ENCRYPTION_KEY cannot
 * decrypt): Customer ID is decrypted only for super_admin/supervisor and the
 * access is audited; missing values print as "—" instead of being invented;
 * oversized exports are refused rather than truncated.
 */
vi.mock('../../lib/encryption.js', () => ({
  decryptField: vi.fn(() => 'PWD-0001'),
  encryptField: vi.fn(),
  hashField: vi.fn(),
}));
vi.mock('../../middleware/audit-log.js', () => ({ recordAuditLog: vi.fn() }));
vi.mock('../../lib/reports/transactions-export.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/reports/transactions-export.js')>();
  return { ...original, generateTransactionsPdf: vi.fn(async () => Buffer.from('%PDF-1.3 test')) };
});

const { transactionsService } = await import('./transactions.service.js');
const { transactionsRepository } = await import('./transactions.repository.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');
const { decryptField } = await import('../../lib/encryption.js');
const { generateTransactionsPdf } = await import('../../lib/reports/transactions-export.js');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    createdAt: new Date('2026-10-27T02:00:00.000Z'),
    transactionNumber: 'PC-MNL-20261027-000001',
    paymentMethod: 'gcash',
    gcashReference: null,
    subtotal: new Prisma.Decimal(100),
    vatAmount: new Prisma.Decimal(0),
    discountAmount: new Prisma.Decimal(20),
    discountType: 'senior_citizen',
    discountCustomerIdEncrypted: 'cipher',
    totalAmount: new Prisma.Decimal(71.43),
    status: 'completed',
    cashier: { firstName: 'Ana', lastName: 'Cruz' },
    branch: { name: 'Manila', code: 'MNL' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(transactionsRepository, 'countForExport').mockResolvedValue(1);
  vi.spyOn(transactionsRepository, 'findForExport').mockResolvedValue([row()] as never);
});

function exportedRows() {
  const call = vi.mocked(generateTransactionsPdf).mock.calls[0];
  if (!call) throw new Error('PDF was not generated');
  return call[0];
}

describe('exportTransactionsPdf', () => {
  it('decrypts Customer ID for a supervisor and audits the access', async () => {
    await transactionsService.exportTransactionsPdf({ branchId: 'b1' }, { branchName: 'Manila' }, { id: 'u1', role: 'supervisor' }, '127.0.0.1');
    expect(exportedRows()[0]?.customer_id).toBe('PWD-0001');
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'DISCOUNT_AUDIT_PII_ACCESSED', actorId: 'u1' }));
  });

  it('never decrypts for any other role', async () => {
    await transactionsService.exportTransactionsPdf({ branchId: 'b1' }, { branchName: 'Manila' }, { id: 'u2', role: 'branch' }, null);
    expect(decryptField).not.toHaveBeenCalled();
    expect(exportedRows()[0]?.customer_id).toBe('—');
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it('prints missing historical values as "—" and keeps stored amounts as they are', async () => {
    vi.spyOn(transactionsRepository, 'findForExport').mockResolvedValue([
      row({ cashier: null, gcashReference: null, discountAmount: new Prisma.Decimal(0), discountType: null, discountCustomerIdEncrypted: null }),
    ] as never);
    await transactionsService.exportTransactionsPdf({ branchId: 'b1' }, { branchName: 'Manila' }, { id: 'u1', role: 'super_admin' }, null);
    const [exported] = exportedRows();
    expect(exported).toMatchObject({ cashier: '—', reference: '—', discount: '—', discount_type: '—', customer_id: '—', subtotal: '100.00', total: '71.43' });
  });

  it('states whether the export is the filtered set or one transaction', async () => {
    await transactionsService.exportTransactionsPdf({ branchId: 'b1', dateFrom: '2026-10-27', dateTo: '2026-10-27' }, { branchName: 'Manila' }, { id: 'u1', role: 'super_admin' }, null);
    const filteredScope = vi.mocked(generateTransactionsPdf).mock.calls[0]?.[1];
    expect(filteredScope?.kind).toBe('filtered');
    expect(filteredScope?.filterLines.join(' ')).toContain('2026-10-27 to 2026-10-27');

    vi.mocked(generateTransactionsPdf).mockClear();
    const result = await transactionsService.exportTransactionsPdf({ transactionId: 't1' }, { branchName: null }, { id: 'u1', role: 'super_admin' }, null);
    expect(vi.mocked(generateTransactionsPdf).mock.calls[0]?.[1].kind).toBe('single');
    expect(result.filename).toBe('transactions-single-PC-MNL-20261027-000001.pdf');
  });

  it('refuses an oversized export with a clear message instead of truncating', async () => {
    vi.spyOn(transactionsRepository, 'countForExport').mockResolvedValue(2001);
    await expect(
      transactionsService.exportTransactionsPdf({}, { branchName: null }, { id: 'u1', role: 'super_admin' }, null),
    ).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE', statusCode: 422 });
    expect(transactionsRepository.findForExport).not.toHaveBeenCalled();
  });
});
