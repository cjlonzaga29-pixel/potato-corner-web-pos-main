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
    countActiveHoldOrdersForShift: vi.fn(),
    createHoldOrder: vi.fn(),
    findHoldOrderById: vi.fn(),
    listActiveHoldOrdersForShift: vi.fn(),
    releaseHoldOrder: vi.fn(),
    findDiscountAuditTrail: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    fraudAlert: { findMany: vi.fn() },
    transaction: { update: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(prismaMock)),
  };
  return { prisma: prismaMock };
});

// Inventory deduction/reversal is exercised by inventory.integration.test.ts;
// these tests cover pricing, VAT, and sync — stub the recipe lookup to no-op
// so prisma.$transaction's callback doesn't need real recipe/ingredient rows.
vi.mock('../recipes/recipes.service.js', () => ({
  computeDeduction: vi.fn().mockResolvedValue([]),
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
  decryptField: vi.fn((value: string) => `decrypted(${value})`),
}));

vi.mock('../../queues/notification.queue.js', () => ({
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../queues/hold-order.queue.js', () => ({
  enqueueHoldOrderExpiry: vi.fn().mockResolvedValue(undefined),
}));

const { transactionsRepository } = await import('./transactions.repository.js');
const { cashRepository } = await import('../cash/cash.repository.js');
const { priceOverridesService } = await import('../price-overrides/price-overrides.service.js');
const { enqueueNotification } = await import('../../queues/notification.queue.js');
const { enqueueHoldOrderExpiry } = await import('../../queues/hold-order.queue.js');
const { notifyBranch, notifySuperAdmin } = await import('../../lib/notify.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');
const { prisma } = await import('../../lib/prisma.js');
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

function holdOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hold-1',
    branchId: 'branch-1',
    shiftId: 'shift-1',
    cashierId: 'user-1',
    status: 'held',
    expiresAt: new Date('2026-07-19T10:15:00.000Z'),
    releasedAt: null,
    expiredAt: null,
    createdAt: new Date('2026-07-19T10:00:00.000Z'),
    items: [],
    ...overrides,
  };
}

const baseHoldInput = {
  branchId: 'branch-1',
  shiftId: 'shift-1',
  cashierId: 'user-1',
  items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1 }],
};

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
  vi.mocked(transactionsRepository.countActiveHoldOrdersForShift).mockResolvedValue(0);
  vi.mocked(transactionsRepository.createHoldOrder).mockResolvedValue(holdOrderRow() as never);
});

describe('transactionsService.createTransaction — VAT calculation', () => {
  it('extracts VAT via the 12/112 VAT-inclusive formula when there is no discount', async () => {
    await transactionsService.createTransaction(baseInput, null);

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ subtotal: 100, discountAmount: 0, vatAmount: 10.71, totalAmount: 100 }),
      expect.anything(),
    );
  });

  it('applies the PWD/Senior Citizen VAT-exempt formula (₱100 item, PWD discount)', async () => {
    await transactionsService.createTransaction(
      { ...baseInput, discountType: 'pwd', discountIdReference: 'PWD-000123' },
      null,
    );

    // Step 1: 100 / 1.12 = 89.2857..., Step 2: ×0.20 = 17.86, Step 3: 71.43.
    // No VAT is charged — PWD/Senior sales are true VAT-exempt (RA 9994 /
    // RA 10754), so total is the discounted base with nothing added back.
    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ discountAmount: 17.86, vatAmount: 0, vatExemptAmount: 0, totalAmount: 71.43 }),
      expect.anything(),
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
      expect.anything(),
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
      expect.anything(),
    );
  });

  it('rejects an item whose product is not available at the branch', async () => {
    vi.mocked(transactionsRepository.findBranchProductAvailabilityMap).mockResolvedValue([{ productId: 'product-1', isAvailable: false }] as never);

    await expect(transactionsService.createTransaction(baseInput, null)).rejects.toMatchObject({ code: 'PRODUCT_UNAVAILABLE' });
  });
});

describe('transactionsService.createTransaction — side effects', () => {
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
      expect.anything(),
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
      expect.anything(),
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
    expect(enqueueNotification).toHaveBeenCalledWith('void_requested', {
      type: 'void_requested',
      branchId: result.branch_id,
      transactionNumber: result.receipt_number,
      requestedByUserId: 'admin-1',
      amount: result.total_amount,
      reason: result.void_reason,
    });
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

describe('transactionsService.syncOfflineTransactions', () => {
  const offlineItem = (overrides: Record<string, unknown> = {}) => ({
    offlineProvisionalNumber: 'PC-MNL001-20260719-OFFLINE-0001',
    shiftId: 'shift-1',
    items: baseInput.items,
    paymentMethod: 'cash' as const,
    cashTendered: 100,
    clientCreatedAt: 1000,
    ...overrides,
  });

  it('processes the batch in chronological order (client_created_at), not submission order', async () => {
    const earlier = offlineItem({ offlineProvisionalNumber: 'PC-MNL001-20260719-OFFLINE-0002', clientCreatedAt: 1000 });
    const later = offlineItem({ offlineProvisionalNumber: 'PC-MNL001-20260719-OFFLINE-0003', clientCreatedAt: 2000 });

    // Submitted out of order — later item first.
    await transactionsService.syncOfflineTransactions({ branchId: 'branch-1', cashierId: 'user-1', transactions: [later, earlier] }, null);

    const calls = vi.mocked(transactionsRepository.createTransaction).mock.calls;
    const [firstCall, secondCall] = calls;
    expect(firstCall?.[0]).toMatchObject({ offlineProvisionalNumber: earlier.offlineProvisionalNumber });
    expect(secondCall?.[0]).toMatchObject({ offlineProvisionalNumber: later.offlineProvisionalNumber });
  });

  it('marks a failed item without stopping the rest of the batch from syncing', async () => {
    const insufficientCash = offlineItem({ offlineProvisionalNumber: 'PC-MNL001-20260719-OFFLINE-0004', cashTendered: 1, clientCreatedAt: 1000 });
    const valid = offlineItem({ offlineProvisionalNumber: 'PC-MNL001-20260719-OFFLINE-0005', cashTendered: 100, clientCreatedAt: 2000 });

    const result = await transactionsService.syncOfflineTransactions(
      { branchId: 'branch-1', cashierId: 'user-1', transactions: [insufficientCash, valid] },
      null,
    );

    expect(result.results).toEqual([
      expect.objectContaining({ offline_provisional_number: insufficientCash.offlineProvisionalNumber, status: 'failed' }),
      expect.objectContaining({ offline_provisional_number: valid.offlineProvisionalNumber, status: 'synced' }),
    ]);
    const [firstResult] = result.results;
    expect(firstResult?.error).toMatchObject({ code: 'INSUFFICIENT_CASH_TENDERED' });
    expect(result.synced_count).toBe(1);
    expect(transactionsRepository.createTransaction).toHaveBeenCalledTimes(1);
  });

  it('enqueues offline_transactions_synced with the synced count when at least one item syncs', async () => {
    await transactionsService.syncOfflineTransactions({ branchId: 'branch-1', cashierId: 'user-1', transactions: [offlineItem()] }, null);

    expect(enqueueNotification).toHaveBeenCalledWith('offline_transactions_synced', {
      type: 'offline_transactions_synced',
      branchId: 'branch-1',
      syncedCount: 1,
    });
  });

  it('does not enqueue offline_transactions_synced when every item in the batch fails', async () => {
    const insufficientCash = offlineItem({ cashTendered: 1 });

    await transactionsService.syncOfflineTransactions({ branchId: 'branch-1', cashierId: 'user-1', transactions: [insufficientCash] }, null);

    expect(enqueueNotification).not.toHaveBeenCalledWith('offline_transactions_synced', expect.anything());
  });
});

describe('transactionsService.holdOrder — 3-per-terminal limit', () => {
  it('allows holding an order when the shift has fewer than 3 active holds', async () => {
    vi.mocked(transactionsRepository.countActiveHoldOrdersForShift).mockResolvedValue(2);

    await expect(transactionsService.holdOrder(baseHoldInput, null)).resolves.toMatchObject({ id: 'hold-1' });
    expect(transactionsRepository.createHoldOrder).toHaveBeenCalled();
  });

  it('rejects holding a 4th order once the shift already has 3 active holds', async () => {
    vi.mocked(transactionsRepository.countActiveHoldOrdersForShift).mockResolvedValue(3);

    await expect(transactionsService.holdOrder(baseHoldInput, null)).rejects.toMatchObject({ code: 'HOLD_ORDER_LIMIT_REACHED' });
    expect(transactionsRepository.createHoldOrder).not.toHaveBeenCalled();
  });

  it('rejects holding an order on a shift that is not open', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue({ id: 'shift-1', branchId: 'branch-1', status: 'closed' } as never);

    await expect(transactionsService.holdOrder(baseHoldInput, null)).rejects.toMatchObject({ code: 'SHIFT_CLOSED' });
    expect(transactionsRepository.createHoldOrder).not.toHaveBeenCalled();
  });
});

describe('transactionsService.holdOrder — expiry scheduling', () => {
  it('enqueues a 15-minute expiry job (HOLD_ORDER_EXPIRY_MS) after the hold is persisted', async () => {
    await transactionsService.holdOrder(baseHoldInput, null);

    expect(enqueueHoldOrderExpiry).toHaveBeenCalledWith({ holdOrderId: 'hold-1', branchId: 'branch-1', shiftId: 'shift-1' }, 15 * 60 * 1000);
  });

  it('does not fail the hold if enqueueing the expiry job throws', async () => {
    vi.mocked(enqueueHoldOrderExpiry).mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(transactionsService.holdOrder(baseHoldInput, null)).resolves.toMatchObject({ id: 'hold-1' });
  });
});

describe('transactionsService.listHoldOrders', () => {
  it('returns only active (held) orders for the given shift', async () => {
    vi.mocked(transactionsRepository.listActiveHoldOrdersForShift).mockResolvedValue([holdOrderRow()] as never);

    const result = await transactionsService.listHoldOrders('shift-1');

    expect(transactionsRepository.listActiveHoldOrdersForShift).toHaveBeenCalledWith('shift-1');
    expect(result.hold_orders).toHaveLength(1);
    expect(result.hold_orders[0]).toMatchObject({ id: 'hold-1', status: 'held' });
  });
});

describe('transactionsService.releaseHoldOrder', () => {
  it('rejects releasing a hold order that has already expired', async () => {
    vi.mocked(transactionsRepository.findHoldOrderById).mockResolvedValue(holdOrderRow({ status: 'expired' }) as never);

    await expect(
      transactionsService.releaseHoldOrder('hold-1', { id: 'user-1', role: 'staff' }, null),
    ).rejects.toMatchObject({ code: 'HOLD_ORDER_NOT_ACTIVE' });
    expect(transactionsRepository.releaseHoldOrder).not.toHaveBeenCalled();
  });

  it('rejects releasing a hold order that does not exist', async () => {
    vi.mocked(transactionsRepository.findHoldOrderById).mockResolvedValue(null);

    await expect(
      transactionsService.releaseHoldOrder('missing', { id: 'user-1', role: 'staff' }, null),
    ).rejects.toMatchObject({ code: 'HOLD_ORDER_NOT_FOUND' });
  });

  it('marks a held order released and returns it', async () => {
    vi.mocked(transactionsRepository.findHoldOrderById).mockResolvedValue(holdOrderRow() as never);
    vi.mocked(transactionsRepository.releaseHoldOrder).mockResolvedValue(
      holdOrderRow({ status: 'released', releasedAt: new Date('2026-07-19T10:05:00.000Z') }) as never,
    );

    const result = await transactionsService.releaseHoldOrder('hold-1', { id: 'user-1', role: 'staff' }, null);

    expect(result).toMatchObject({ id: 'hold-1', status: 'released' });
  });
});

describe('transactionsService.getDiscountAuditTrail', () => {
  function discountAuditRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'txn-1',
      branchId: 'branch-1',
      transactionNumber: 'MNL001-20260714-000001',
      discountType: 'pwd',
      discountAmount: decimal(20),
      discountCustomerIdEncrypted: null,
      discountCustomerIdHash: 'hashed(PWD-12345)',
      createdAt: new Date('2026-07-14T10:00:00.000Z'),
      ...overrides,
    };
  }

  const baseFilters = { branchIds: 'all' as const, page: 1, limit: 25 };
  const superAdminActor = { id: 'admin-1', role: 'super_admin' };
  const staffActor = { id: 'staff-1', role: 'staff' };

  beforeEach(() => {
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([]);
  });

  it('returns empty data when no discount transactions exist', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({ rows: [], total: 0 } as never);

    const result = await transactionsService.getDiscountAuditTrail(baseFilters, superAdminActor, null);

    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
    // No branches referenced by the (empty) row set, so the fraud-alert
    // lookup is skipped entirely rather than querying with branchId: { in: [] }.
    expect(prisma.fraudAlert.findMany).not.toHaveBeenCalled();
  });

  it('sets fraudFlagged true when a FraudAlert.evidence.transaction_ids includes the row id', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({
      rows: [discountAuditRow({ id: 'txn-flagged' })],
      total: 1,
    } as never);
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([
      { branchId: 'branch-1', status: 'open', evidence: { transaction_ids: ['txn-flagged'] } },
    ] as never);

    const result = await transactionsService.getDiscountAuditTrail(baseFilters, staffActor, null);

    expect(result.data[0]).toMatchObject({ fraudFlagged: true });
  });

  it('sets fraudFlagged false when no matching fraud alert exists', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({
      rows: [discountAuditRow({ id: 'txn-clean' })],
      total: 1,
    } as never);
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([
      { branchId: 'branch-1', status: 'open', evidence: { transaction_ids: ['some-other-txn'] } },
    ] as never);

    const result = await transactionsService.getDiscountAuditTrail(baseFilters, staffActor, null);

    expect(result.data[0]).toMatchObject({ fraudFlagged: false });
  });

  it('decrypts discountCustomerId only when actor.role === super_admin AND the encrypted field is present', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({
      rows: [discountAuditRow({ discountCustomerIdEncrypted: 'encrypted(PWD-12345)' })],
      total: 1,
    } as never);

    const result = await transactionsService.getDiscountAuditTrail(baseFilters, superAdminActor, null);

    expect(result.data[0]).toMatchObject({ discountCustomerId: 'decrypted(encrypted(PWD-12345))' });
  });

  it('leaves discountCustomerId null when actor.role !== super_admin', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({
      rows: [discountAuditRow({ discountCustomerIdEncrypted: 'encrypted(PWD-12345)' })],
      total: 1,
    } as never);

    const result = await transactionsService.getDiscountAuditTrail(baseFilters, staffActor, null);

    expect(result.data[0]).toMatchObject({ discountCustomerId: null });
  });

  it('leaves discountCustomerId null when discountCustomerIdEncrypted is null', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({
      rows: [discountAuditRow({ discountCustomerIdEncrypted: null })],
      total: 1,
    } as never);

    const result = await transactionsService.getDiscountAuditTrail(baseFilters, superAdminActor, null);

    expect(result.data[0]).toMatchObject({ discountCustomerId: null });
  });

  it('calls recordAuditLog with DISCOUNT_AUDIT_PII_ACCESSED only when at least one decryption occurred', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({
      rows: [discountAuditRow({ discountCustomerIdEncrypted: 'encrypted(PWD-12345)' })],
      total: 1,
    } as never);

    await transactionsService.getDiscountAuditTrail(baseFilters, superAdminActor, '127.0.0.1');

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DISCOUNT_AUDIT_PII_ACCESSED',
        actorId: 'admin-1',
        actorRole: 'super_admin',
        ipAddress: '127.0.0.1',
      }),
    );
  });

  it('does NOT call recordAuditLog when no decryption occurred (non-super-admin actor)', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({
      rows: [discountAuditRow({ discountCustomerIdEncrypted: 'encrypted(PWD-12345)' })],
      total: 1,
    } as never);

    await transactionsService.getDiscountAuditTrail(baseFilters, staffActor, null);

    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  // NOTE: skip/take and the branchId where-clause are actually built inside
  // transactionsRepository.findDiscountAuditTrail (transactions.repository.ts),
  // which is mocked out for this service-level suite. The two tests below
  // verify the service's side of the contract — that it forwards `filters`
  // to the repository unchanged rather than re-deriving or dropping fields.
  // Asserting the resulting Prisma `where`/`skip`/`take` shape belongs in a
  // transactions.repository-level test, not here.
  it('forwards filters.page and filters.limit unchanged to the repository (pagination)', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({ rows: [], total: 0 } as never);
    const filters = { branchIds: 'all' as const, page: 3, limit: 10 };

    await transactionsService.getDiscountAuditTrail(filters, superAdminActor, null);

    expect(transactionsRepository.findDiscountAuditTrail).toHaveBeenCalledWith(
      expect.objectContaining({ page: 3, limit: 10 }),
    );
  });

  it("forwards branchIds: 'all' unchanged so the repository applies no branchId where clause", async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({ rows: [], total: 0 } as never);

    await transactionsService.getDiscountAuditTrail({ branchIds: 'all', page: 1, limit: 25 }, superAdminActor, null);

    expect(transactionsRepository.findDiscountAuditTrail).toHaveBeenCalledWith(
      expect.objectContaining({ branchIds: 'all' }),
    );
  });

  it('forwards branchIds as an array unchanged so the repository builds a branchId `in` where clause', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({ rows: [], total: 0 } as never);

    await transactionsService.getDiscountAuditTrail(
      { branchIds: ['branch-1', 'branch-2'], page: 1, limit: 25 },
      superAdminActor,
      null,
    );

    expect(transactionsRepository.findDiscountAuditTrail).toHaveBeenCalledWith(
      expect.objectContaining({ branchIds: ['branch-1', 'branch-2'] }),
    );
  });
});
