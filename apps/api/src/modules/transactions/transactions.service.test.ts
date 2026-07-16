import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { transactionResponseSchema } from '@potato-corner/shared';

vi.mock('../../lib/notify.js', () => ({
  notifyBranch: vi.fn(),
  notifySuperAdmin: vi.fn(),
}));

vi.mock('./transactions.repository.js', () => ({
  transactionsRepository: {
    findBranch: vi.fn(),
    findVariantsForSale: vi.fn(),
    findBranchProductAvailabilityMap: vi.fn(),
    findBranchFlavorAvailabilityMap: vi.fn(),
    countTransactionsWithPrefix: vi.fn(),
    createTransaction: vi.fn(),
    findTransactionById: vi.fn(),
    listTransactions: vi.fn(),
    voidTransaction: vi.fn(),
    refundTransaction: vi.fn(),
    markReceiptPrinted: vi.fn(),
  },
}));

vi.mock('../cash/cash.repository.js', () => ({
  cashRepository: { findShiftById: vi.fn() },
}));

vi.mock('../price-overrides/price-overrides.service.js', () => ({
  priceOverridesService: { getActivePriceForBranch: vi.fn() },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/encryption.js', () => ({
  encryptField: vi.fn((value: string) => `encrypted(${value})`),
  hashField: vi.fn((value: string) => `hashed(${value})`),
}));

vi.mock('../../queues/inventory.queue.js', () => ({
  enqueueSaleDeduction: vi.fn().mockResolvedValue(undefined),
}));

const { transactionsRepository } = await import('./transactions.repository.js');
const { cashRepository } = await import('../cash/cash.repository.js');
const { priceOverridesService } = await import('../price-overrides/price-overrides.service.js');
const { enqueueSaleDeduction } = await import('../../queues/inventory.queue.js');
const { notifyBranch, notifySuperAdmin } = await import('../../lib/notify.js');
const { transactionsService } = await import('./transactions.service.js');
const { TransactionError } = await import('./transactions.types.js');

function decimal(value: number) {
  return { toNumber: () => value };
}

function variantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'variant-1',
    productId: 'product-1',
    name: 'Regular',
    basePrice: decimal(100),
    isActive: true,
    product: { id: 'product-1', name: 'Original', status: 'active' },
    variantFlavors: [],
    ...overrides,
  };
}

function transactionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'txn-1',
    transactionNumber: 'MNL001-20260714-000001',
    branchId: 'branch-1',
    shiftId: 'shift-1',
    cashierId: 'user-1',
    status: 'completed',
    paymentMethod: 'cash',
    subtotal: decimal(100),
    discountAmount: decimal(0),
    discountType: null,
    vatAmount: decimal(10.71),
    vatExemptAmount: decimal(0),
    totalAmount: decimal(100),
    amountTendered: decimal(100),
    changeAmount: decimal(0),
    gcashReference: null,
    gcashManuallyVerified: null,
    receiptPrinted: false,
    inventoryDeductionStatus: 'pending',
    isOfflineTransaction: false,
    offlineProvisionalNumber: null,
    syncedAt: null,
    voidedAt: null,
    voidedById: null,
    voidReason: null,
    refundedAt: null,
    refundedById: null,
    refundReason: null,
    createdAt: new Date('2026-07-14T10:00:00.000Z'),
    updatedAt: new Date('2026-07-14T10:00:00.000Z'),
    items: [],
    shift: { id: 'shift-1', status: 'active', branchId: 'branch-1' },
    ...overrides,
  };
}

const baseInput = {
  branchId: 'branch-1',
  shiftId: 'shift-1',
  cashierId: 'user-1',
  items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1 }],
  paymentMethod: 'cash' as const,
  isOfflineTransaction: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(transactionsRepository.findBranch).mockResolvedValue({ id: 'branch-1', code: 'MNL001', status: 'active' } as never);
  vi.mocked(cashRepository.findShiftById).mockResolvedValue({ id: 'shift-1', branchId: 'branch-1', status: 'active' } as never);
  vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([variantRow()] as never);
  vi.mocked(transactionsRepository.findBranchProductAvailabilityMap).mockResolvedValue([{ productId: 'product-1', isAvailable: true }] as never);
  vi.mocked(transactionsRepository.findBranchFlavorAvailabilityMap).mockResolvedValue([] as never);
  vi.mocked(transactionsRepository.countTransactionsWithPrefix).mockResolvedValue(0);
  vi.mocked(priceOverridesService.getActivePriceForBranch).mockImplementation(async (_b, _v, masterPrice) => masterPrice as number);
  vi.mocked(transactionsRepository.createTransaction).mockResolvedValue(transactionRow() as never);
});

describe('transactionsService.createTransaction — VAT calculation', () => {
  it('extracts VAT via the 12/112 VAT-inclusive formula when there is no discount', async () => {
    await transactionsService.createTransaction(baseInput, null);

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ subtotal: 100, discountAmount: 0, vatAmount: 10.71, totalAmount: 100 }),
    );
  });

  it('applies the architecture doc\'s locked PWD/Senior Citizen 5-step formula (₱100 item, PWD discount)', async () => {
    await transactionsService.createTransaction(
      { ...baseInput, discountType: 'pwd', discountIdReference: 'PWD-000123' },
      null,
    );

    // Step 1: 100 / 1.12 = 89.2857..., Step 2: ×0.20 = 17.86, Step 3: 71.43,
    // Step 4: ×0.12 = 8.57, Step 5: 71.43 + 8.57 = 80.00.
    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ discountAmount: 17.86, vatAmount: 8.57, vatExemptAmount: 0, totalAmount: 80 }),
    );
  });
});

describe('transactionsService.createTransaction — payment validation', () => {
  it('rejects a GCash payment that has not been manually verified', async () => {
    await expect(
      transactionsService.createTransaction(
        { ...baseInput, paymentMethod: 'gcash', gcashReferenceNumber: '1234567890', gcashManuallyVerified: false },
        null,
      ),
    ).rejects.toThrow(TransactionError);
    await expect(
      transactionsService.createTransaction(
        { ...baseInput, paymentMethod: 'gcash', gcashReferenceNumber: '1234567890', gcashManuallyVerified: false },
        null,
      ),
    ).rejects.toMatchObject({ code: 'GCASH_NOT_VERIFIED' });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('rejects a cash payment where cash_tendered is less than total_amount', async () => {
    await expect(transactionsService.createTransaction({ ...baseInput, cashTendered: 50 }, null)).rejects.toMatchObject({
      code: 'INSUFFICIENT_CASH_TENDERED',
    });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('requires discount_id_reference for a PWD/Senior Citizen discount', async () => {
    await expect(
      transactionsService.createTransaction({ ...baseInput, discountType: 'senior_citizen' }, null),
    ).rejects.toMatchObject({ code: 'DISCOUNT_ID_REQUIRED' });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('rejects manager_override — not implemented in Phase 10 (requires supervisor PIN)', async () => {
    await expect(
      transactionsService.createTransaction({ ...baseInput, discountType: 'manager_override' }, null),
    ).rejects.toMatchObject({ code: 'DISCOUNT_TYPE_NOT_SUPPORTED' });
  });
});

describe('transactionsService.createTransaction — shift validation', () => {
  it('rejects when shift_id does not belong to branch_id', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue({ id: 'shift-1', branchId: 'branch-2', status: 'active' } as never);

    await expect(transactionsService.createTransaction(baseInput, null)).rejects.toMatchObject({ code: 'INVALID_SHIFT' });
  });

  it('rejects when the shift is not active', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue({ id: 'shift-1', branchId: 'branch-1', status: 'closed' } as never);

    await expect(transactionsService.createTransaction(baseInput, null)).rejects.toMatchObject({ code: 'SHIFT_CLOSED' });
  });
});

describe('transactionsService.createTransaction — pricing and snapshots', () => {
  it('uses the branch price override instead of the master base_price when one is active', async () => {
    vi.mocked(priceOverridesService.getActivePriceForBranch).mockResolvedValue(45);

    await transactionsService.createTransaction(baseInput, null);

    expect(priceOverridesService.getActivePriceForBranch).toHaveBeenCalledWith('branch-1', 'variant-1', 100);
    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ subtotal: 45, items: [expect.objectContaining({ unitPrice: 45, lineTotal: 45 })] }),
    );
  });

  it('snapshots product/variant/flavor names and the resolved price at time of sale', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({
        variantFlavors: [{ flavorId: 'flavor-1', isAvailable: true, pricePremium: decimal(5), flavor: { id: 'flavor-1', name: 'Sour Cream', isActive: true } }],
      }),
    ] as never);

    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', flavorId: 'flavor-1', quantity: 2 }] },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            productName: 'Original',
            variantName: 'Regular',
            flavorName: 'Sour Cream',
            unitPrice: 105,
            quantity: 2,
            lineTotal: 210,
          }),
        ],
      }),
    );
  });

  it('rejects an item whose product is not available at the branch', async () => {
    vi.mocked(transactionsRepository.findBranchProductAvailabilityMap).mockResolvedValue([{ productId: 'product-1', isAvailable: false }] as never);

    await expect(transactionsService.createTransaction(baseInput, null)).rejects.toMatchObject({ code: 'PRODUCT_UNAVAILABLE' });
  });
});

describe('transactionsService.createTransaction — side effects', () => {
  it('enqueues the Phase 8 inventory deduction job after the transaction is persisted', async () => {
    await transactionsService.createTransaction(baseInput, null);

    expect(enqueueSaleDeduction).toHaveBeenCalledWith({
      transactionId: 'txn-1',
      branchId: 'branch-1',
      items: [{ productVariantId: 'variant-1', flavorId: null, quantity: 1 }],
    });
  });

  it('does not fail the sale if enqueueing the inventory deduction job throws', async () => {
    vi.mocked(enqueueSaleDeduction).mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(transactionsService.createTransaction(baseInput, null)).resolves.toMatchObject({ id: 'txn-1' });
  });

  it('broadcasts TRANSACTION_COMPLETED to the branch room and Super Admin with a payload matching transactionResponseSchema', async () => {
    vi.mocked(transactionsRepository.createTransaction).mockResolvedValue(
      transactionRow({ id: randomUUID(), branchId: randomUUID(), shiftId: randomUUID(), cashierId: randomUUID() }) as never,
    );

    const result = await transactionsService.createTransaction(baseInput, null);

    expect(notifyBranch).toHaveBeenCalledWith('branch-1', 'transaction:completed', result);
    expect(notifySuperAdmin).toHaveBeenCalledWith('transaction:completed', result);
    expect(transactionResponseSchema.safeParse(result).success).toBe(true);
  });
});

describe('transactionsService.createTransaction — discount ID hashing', () => {
  it('populates discountCustomerIdHash alongside the encrypted field for a PWD discount', async () => {
    vi.mocked(transactionsRepository.findBranch).mockResolvedValue({ id: 'branch-1', code: 'MNL001', status: 'active' } as never);
    vi.mocked(cashRepository.findShiftById).mockResolvedValue({ id: 'shift-1', branchId: 'branch-1', status: 'active' } as never);
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([variantRow()] as never);
    vi.mocked(transactionsRepository.findBranchProductAvailabilityMap).mockResolvedValue([{ productId: 'product-1', isAvailable: true }] as never);
    vi.mocked(priceOverridesService.getActivePriceForBranch).mockResolvedValue(100);
    vi.mocked(transactionsRepository.countTransactionsWithPrefix).mockResolvedValue(0);
    vi.mocked(transactionsRepository.createTransaction).mockResolvedValue(transactionRow({ discountType: 'pwd' }) as never);

    await transactionsService.createTransaction(
      {
        branchId: 'branch-1',
        shiftId: 'shift-1',
        cashierId: 'user-1',
        items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1 }],
        paymentMethod: 'cash',
        discountType: 'pwd',
        discountIdReference: 'PWD-12345',
        cashTendered: 200,
        isOfflineTransaction: false,
      },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        discountCustomerIdEncrypted: 'encrypted(PWD-12345)',
        discountCustomerIdHash: 'hashed(PWD-12345)',
      }),
    );
  });

  it('leaves discountCustomerIdHash null when there is no discount ID reference', async () => {
    vi.mocked(transactionsRepository.findBranch).mockResolvedValue({ id: 'branch-1', code: 'MNL001', status: 'active' } as never);
    vi.mocked(cashRepository.findShiftById).mockResolvedValue({ id: 'shift-1', branchId: 'branch-1', status: 'active' } as never);
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([variantRow()] as never);
    vi.mocked(transactionsRepository.findBranchProductAvailabilityMap).mockResolvedValue([{ productId: 'product-1', isAvailable: true }] as never);
    vi.mocked(priceOverridesService.getActivePriceForBranch).mockResolvedValue(100);
    vi.mocked(transactionsRepository.countTransactionsWithPrefix).mockResolvedValue(0);
    vi.mocked(transactionsRepository.createTransaction).mockResolvedValue(transactionRow() as never);

    await transactionsService.createTransaction(
      {
        branchId: 'branch-1',
        shiftId: 'shift-1',
        cashierId: 'user-1',
        items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1 }],
        paymentMethod: 'cash',
        cashTendered: 200,
        isOfflineTransaction: false,
      },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ discountCustomerIdEncrypted: null, discountCustomerIdHash: null }),
    );
  });
});

describe('transactionsService.getTransactionById', () => {
  it('throws TRANSACTION_NOT_FOUND for a missing id', async () => {
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(null);

    await expect(transactionsService.getTransactionById('missing')).rejects.toMatchObject({ code: 'TRANSACTION_NOT_FOUND' });
  });
});

describe('transactionsService.voidTransaction', () => {
  it('rejects voiding a transaction from a shift that is no longer active', async () => {
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(
      transactionRow({ shift: { id: 'shift-1', status: 'closed', branchId: 'branch-1' } }) as never,
    );

    await expect(
      transactionsService.voidTransaction('txn-1', 'customer changed mind', { id: 'admin-1', role: 'super_admin' }, null),
    ).rejects.toMatchObject({ code: 'SHIFT_CLOSED' });
  });

  it('rejects a transaction that is already voided', async () => {
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(transactionRow({ status: 'voided' }) as never);

    await expect(
      transactionsService.voidTransaction('txn-1', 'reason', { id: 'admin-1', role: 'super_admin' }, null),
    ).rejects.toMatchObject({ code: 'TRANSACTION_ALREADY_VOIDED' });
  });

  it('broadcasts VOID_REQUESTED to the branch room and Super Admin with the void payload', async () => {
    const branchId = randomUUID();
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(
      transactionRow({ shift: { id: 'shift-1', status: 'active', branchId } }) as never,
    );
    vi.mocked(transactionsRepository.voidTransaction).mockResolvedValue(
      transactionRow({ branchId, status: 'voided', voidedById: 'admin-1', voidReason: 'customer changed mind' }) as never,
    );

    const result = await transactionsService.voidTransaction(
      'txn-1',
      'customer changed mind',
      { id: 'admin-1', role: 'super_admin' },
      null,
    );

    const expectedPayload = {
      transactionId: result.id,
      branchId: result.branch_id,
      voidedBy: 'admin-1',
      amount: result.total_amount,
      reason: result.void_reason,
    };
    expect(notifyBranch).toHaveBeenCalledWith(branchId, 'void:requested', expectedPayload);
    expect(notifySuperAdmin).toHaveBeenCalledWith('void:requested', expectedPayload);
  });
});

describe('transactionsService.refundTransaction', () => {
  it('rejects a transaction that is already refunded', async () => {
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(transactionRow({ status: 'refunded' }) as never);

    await expect(
      transactionsService.refundTransaction('txn-1', 'defective', { id: 'admin-1', role: 'super_admin' }, null),
    ).rejects.toMatchObject({ code: 'TRANSACTION_ALREADY_REFUNDED' });
  });

  it('rejects a transaction that has already been voided', async () => {
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(transactionRow({ status: 'voided' }) as never);

    await expect(
      transactionsService.refundTransaction('txn-1', 'defective', { id: 'admin-1', role: 'super_admin' }, null),
    ).rejects.toMatchObject({ code: 'TRANSACTION_ALREADY_VOIDED' });
  });

  it('broadcasts TRANSACTION_REFUNDED to the branch room and Super Admin with the refund payload', async () => {
    const branchId = randomUUID();
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(transactionRow({ branchId }) as never);
    vi.mocked(transactionsRepository.refundTransaction).mockResolvedValue(
      transactionRow({ branchId, status: 'refunded', refundedById: 'admin-1', refundReason: 'defective' }) as never,
    );

    const result = await transactionsService.refundTransaction('txn-1', 'defective', { id: 'admin-1', role: 'super_admin' }, null);

    const expectedPayload = {
      transactionId: result.id,
      branchId: result.branch_id,
      refundedBy: 'admin-1',
      amount: result.total_amount,
    };
    expect(notifyBranch).toHaveBeenCalledWith(branchId, 'transaction:refunded', expectedPayload);
    expect(notifySuperAdmin).toHaveBeenCalledWith('transaction:refunded', expectedPayload);
  });
});
