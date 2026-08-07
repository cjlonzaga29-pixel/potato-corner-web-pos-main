import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mocks lib/prisma.js directly (same technique as cash.repository.test.ts)
 * so each repository method's exact where/data/include shape can be
 * asserted — transactions.repository.ts is the only place in this module
 * allowed to touch Prisma.
 */
vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    branch: { findUnique: vi.fn() },
    productVariant: { findMany: vi.fn() },
    branchProductAvailability: { findMany: vi.fn() },
    branchFlavorAvailability: { findMany: vi.fn() },
    transaction: {
      count: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      groupBy: vi.fn(),
    },
    transactionItem: { createMany: vi.fn() },
    shift: { findMany: vi.fn() },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prismaMock)),
  };
  return { prisma: prismaMock };
});

const { prisma } = await import('../../lib/prisma.js');
const { transactionsRepository } = await import('./transactions.repository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('transactionsRepository.findBranch', () => {
  it('selects id, code, and status', async () => {
    vi.mocked(prisma.branch.findUnique).mockResolvedValue(null);

    await transactionsRepository.findBranch('branch-1');

    expect(prisma.branch.findUnique).toHaveBeenCalledWith({
      where: { id: 'branch-1' },
      select: { id: true, code: true, status: true },
    });
  });
});

describe('transactionsRepository.findVariantsForSale', () => {
  it('includes product status and available variant flavors', async () => {
    vi.mocked(prisma.productVariant.findMany).mockResolvedValue([]);

    await transactionsRepository.findVariantsForSale(['variant-1', 'variant-2']);

    expect(prisma.productVariant.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['variant-1', 'variant-2'] } },
      include: {
        product: { select: { id: true, name: true, status: true } },
        variantFlavors: { include: { flavor: { select: { id: true, name: true, isActive: true } } } },
        optionGroupAssignments: {
          include: {
            optionGroup: {
              select: {
                id: true,
                name: true,
                posButtonLabel: true,
                options: {
                  where: { isActive: true },
                  select: { id: true, name: true, isActive: true, priceAdjustment: true },
                },
              },
            },
            allowedOptions: {
              include: { productOption: { select: { id: true, name: true, isActive: true, priceAdjustment: true } } },
            },
          },
        },
        flavorSlots: {
          orderBy: { slotIndex: 'asc' },
          include: {
            snackOptions: {
              include: {
                snackProductVariant: {
                  select: {
                    id: true,
                    isActive: true,
                    product: { select: { id: true, status: true } },
                    variantFlavors: { include: { flavor: { select: { id: true, name: true, isActive: true } } } },
                  },
                },
              },
            },
          },
        },
      },
    });
  });
});

describe('transactionsRepository.findBranchProductAvailabilityMap', () => {
  it('scopes to the branch and requested product ids', async () => {
    vi.mocked(prisma.branchProductAvailability.findMany).mockResolvedValue([]);

    await transactionsRepository.findBranchProductAvailabilityMap('branch-1', ['product-1']);

    expect(prisma.branchProductAvailability.findMany).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', productId: { in: ['product-1'] } },
      select: { productId: true, isAvailable: true },
    });
  });
});

describe('transactionsRepository.countTransactionsWithPrefix', () => {
  it('counts by transactionNumber startsWith', async () => {
    vi.mocked(prisma.transaction.count).mockResolvedValue(3);

    const result = await transactionsRepository.countTransactionsWithPrefix('MNL001-20260714-');

    expect(prisma.transaction.count).toHaveBeenCalledWith({ where: { transactionNumber: { startsWith: 'MNL001-20260714-' } } });
    expect(result).toBe(3);
  });
});

describe('transactionsRepository.createTransaction', () => {
  it('creates the transaction row with its line items nested in one call, including items+shift in the response', async () => {
    vi.mocked(prisma.transaction.create).mockResolvedValue({ id: 'txn-1' } as never);

    await transactionsRepository.createTransaction({
      branchId: 'branch-1',
      shiftId: 'shift-1',
      cashierId: 'user-1',
      receiptNumber: 'MNL001-20260714-000001',
      paymentMethod: 'cash',
      subtotal: 100,
      discountAmount: 0,
      discountType: null,
      discountCustomerIdEncrypted: null,
      discountCustomerIdHash: null,
      vatAmount: 10.71,
      vatExemptAmount: 0,
      totalAmount: 100,
      cashTendered: 100,
      changeAmount: 0,
      gcashReference: null,
      gcashManuallyVerified: null,
      paymentProofKey: null,
      paymentProofType: null,
      paymentProofUploadedAt: null,
      discountProofKey: null,
      discountProofType: null,
      discountProofUploadedAt: null,
      isOfflineTransaction: false,
      offlineProvisionalNumber: null,
      items: [
        {
          productId: 'product-1',
          productVariantId: 'variant-1',
          flavorId: null,
          productName: 'Original',
          variantName: 'Regular',
          flavorName: null,
          unitPrice: 100,
          quantity: 1,
          lineTotal: 100,
          recipeVersion: 1,
        },
      ],
    });

    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        branchId: 'branch-1',
        shiftId: 'shift-1',
        cashierId: 'user-1',
        transactionNumber: 'MNL001-20260714-000001',
        paymentMethod: 'cash',
        subtotal: 100,
        totalAmount: 100,
        items: {
          create: [
            expect.objectContaining({
              productId: 'product-1',
              productVariantId: 'variant-1',
              quantity: 1,
              lineTotal: 100,
            }),
          ],
        },
      }),
      include: { items: true, shift: { select: { id: true, status: true, branchId: true } } },
    });
    expect(prisma.transactionItem.createMany).not.toHaveBeenCalled();
    expect(prisma.transaction.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('round-trips payment proof key/type/uploadedAt for a non-cash sale', async () => {
    vi.mocked(prisma.transaction.create).mockResolvedValue({ id: 'txn-2' } as never);
    const uploadedAt = new Date('2026-07-25T10:00:00.000Z');

    await transactionsRepository.createTransaction({
      branchId: 'branch-1',
      shiftId: 'shift-1',
      cashierId: 'user-1',
      receiptNumber: 'MNL001-20260714-000002',
      paymentMethod: 'gcash',
      subtotal: 100,
      discountAmount: 0,
      discountType: null,
      discountCustomerIdEncrypted: null,
      discountCustomerIdHash: null,
      vatAmount: 10.71,
      vatExemptAmount: 0,
      totalAmount: 100,
      cashTendered: null,
      changeAmount: null,
      gcashReference: '1234567890',
      gcashManuallyVerified: true,
      paymentProofKey: 'branch-1/shift-1/user-1-123-proof.webp',
      paymentProofType: 'live_capture',
      paymentProofUploadedAt: uploadedAt,
      discountProofKey: null,
      discountProofType: null,
      discountProofUploadedAt: null,
      isOfflineTransaction: false,
      offlineProvisionalNumber: null,
      items: [
        {
          productId: 'product-1',
          productVariantId: 'variant-1',
          flavorId: null,
          productName: 'Original',
          variantName: 'Regular',
          flavorName: null,
          unitPrice: 100,
          quantity: 1,
          lineTotal: 100,
          recipeVersion: 1,
        },
      ],
    });

    expect(prisma.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentProofKey: 'branch-1/shift-1/user-1-123-proof.webp',
          paymentProofType: 'live_capture',
          paymentProofUploadedAt: uploadedAt,
        }),
      }),
    );
  });
});

describe('transactionsRepository.findClosedShiftTransactionSummaries', () => {
  it('fetches shifts closed in the window with their voided and discounted transactions', async () => {
    vi.mocked(prisma.shift.findMany).mockResolvedValue([]);

    const dayStart = new Date('2026-07-16T16:00:00.000Z');
    const dayEnd = new Date('2026-07-17T15:59:59.999Z');
    await transactionsRepository.findClosedShiftTransactionSummaries('branch-1', dayStart, dayEnd);

    expect(prisma.shift.findMany).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', status: { in: ['closed', 'flagged'] }, closedAt: { gte: dayStart, lte: dayEnd } },
      select: {
        id: true,
        cashierId: true,
        closedAt: true,
        transactions: {
          where: { OR: [{ status: 'voided' }, { status: 'completed', discountType: { not: null } }] },
          select: { id: true, status: true, discountType: true, voidedAt: true },
        },
      },
    });
  });
});

describe('transactionsRepository.findGcashCountsByCashierForDate', () => {
  it('groups completed GCash transactions by cashierId', async () => {
    vi.mocked(prisma.transaction.groupBy).mockResolvedValue([{ cashierId: 'user-1', _count: { _all: 6 } }] as never);

    const dayStart = new Date('2026-07-16T16:00:00.000Z');
    const dayEnd = new Date('2026-07-17T15:59:59.999Z');
    const result = await transactionsRepository.findGcashCountsByCashierForDate('branch-1', dayStart, dayEnd);

    expect(prisma.transaction.groupBy).toHaveBeenCalledWith({
      by: ['cashierId'],
      where: { branchId: 'branch-1', paymentMethod: 'gcash', status: 'completed', createdAt: { gte: dayStart, lte: dayEnd } },
      _count: { _all: true },
    });
    expect(result).toEqual([{ cashierId: 'user-1', gcashCount: 6 }]);
  });
});

describe('transactionsRepository.countGcashTransactionsForBranchWindow', () => {
  it('counts completed GCash transactions in the window', async () => {
    vi.mocked(prisma.transaction.count).mockResolvedValue(120);

    const windowStart = new Date('2026-06-17T16:00:00.000Z');
    const windowEnd = new Date('2026-07-17T15:59:59.999Z');
    const result = await transactionsRepository.countGcashTransactionsForBranchWindow('branch-1', windowStart, windowEnd);

    expect(prisma.transaction.count).toHaveBeenCalledWith({
      where: { branchId: 'branch-1', paymentMethod: 'gcash', status: 'completed', createdAt: { gte: windowStart, lte: windowEnd } },
    });
    expect(result).toBe(120);
  });
});

describe('transactionsRepository.findStatutoryDiscountsInWindow', () => {
  it('finds completed PWD/Senior transactions with a non-null hash in the window, across all branches', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);

    const windowStart = new Date('2026-06-17T16:00:00.000Z');
    const windowEnd = new Date('2026-07-17T15:59:59.999Z');
    await transactionsRepository.findStatutoryDiscountsInWindow(windowStart, windowEnd);

    expect(prisma.transaction.findMany).toHaveBeenCalledWith({
      where: {
        status: 'completed',
        discountType: { in: ['pwd', 'senior_citizen'] },
        discountCustomerIdHash: { not: null },
        createdAt: { gte: windowStart, lte: windowEnd },
      },
      select: { id: true, branchId: true, cashierId: true, discountCustomerIdHash: true, createdAt: true },
    });
  });
});

describe('transactionsRepository.findTransactionById', () => {
  it('includes items and shift status/branch', async () => {
    vi.mocked(prisma.transaction.findUnique).mockResolvedValue(null);

    await transactionsRepository.findTransactionById('txn-1');

    expect(prisma.transaction.findUnique).toHaveBeenCalledWith({
      where: { id: 'txn-1' },
      include: { items: true, shift: { select: { id: true, status: true, branchId: true } } },
    });
  });
});

describe('transactionsRepository.listTransactions', () => {
  it('applies branch/shift/status/payment_method filters and pagination', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);
    vi.mocked(prisma.transaction.count).mockResolvedValue(0);

    await transactionsRepository.listTransactions({ branchId: 'branch-1', status: 'completed', page: 2, limit: 10 });

    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { branchId: 'branch-1', status: 'completed' },
        skip: 10,
        take: 10,
      }),
    );
  });

  it('builds a createdAt range when date_from/date_to are provided', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);
    vi.mocked(prisma.transaction.count).mockResolvedValue(0);

    await transactionsRepository.listTransactions({ dateFrom: '2026-07-01', dateTo: '2026-07-14', page: 1, limit: 25 });

    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // Widened to Manila day boundaries, not UTC midnight — see
        // resolveDateRangeBoundary in apps/api/src/lib/manila-time.ts.
        where: { createdAt: { gte: new Date('2026-06-30T16:00:00.000Z'), lte: new Date('2026-07-14T15:59:59.999Z') } },
      }),
    );
  });
});

describe('transactionsRepository.findDiscountAuditTrail', () => {
  it('widens a bare date_from/date_to range to Manila day boundaries, not UTC midnight', async () => {
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);
    vi.mocked(prisma.transaction.count).mockResolvedValue(0);

    await transactionsRepository.findDiscountAuditTrail({
      branchIds: 'all',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-14',
      page: 1,
      limit: 25,
    });

    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: new Date('2026-06-30T16:00:00.000Z'), lte: new Date('2026-07-14T15:59:59.999Z') },
        }),
      }),
    );
  });
});

describe('transactionsRepository.voidTransaction', () => {
  it('sets status voided and stamps voidedAt/voidedById/voidReason', async () => {
    vi.mocked(prisma.transaction.update).mockResolvedValue({ id: 'txn-1' } as never);

    await transactionsRepository.voidTransaction('txn-1', { voidedById: 'admin-1', voidReason: 'customer changed their mind' });

    expect(prisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'txn-1' },
      data: { status: 'voided', voidedAt: expect.any(Date), voidedById: 'admin-1', voidReason: 'customer changed their mind' },
      include: { items: true, shift: { select: { id: true, status: true, branchId: true } } },
    });
  });
});

describe('transactionsRepository.refundTransaction', () => {
  it('sets status refunded and stamps refundedAt/refundedById/refundReason', async () => {
    vi.mocked(prisma.transaction.update).mockResolvedValue({ id: 'txn-1' } as never);

    await transactionsRepository.refundTransaction('txn-1', { refundedById: 'admin-1', refundReason: 'defective product' });

    expect(prisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'txn-1' },
      data: { status: 'refunded', refundedAt: expect.any(Date), refundedById: 'admin-1', refundReason: 'defective product' },
      include: { items: true, shift: { select: { id: true, status: true, branchId: true } } },
    });
  });
});

describe('transactionsRepository.markReceiptPrinted', () => {
  it('sets receiptPrinted to true', async () => {
    vi.mocked(prisma.transaction.update).mockResolvedValue({ id: 'txn-1' } as never);

    await transactionsRepository.markReceiptPrinted('txn-1');

    expect(prisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'txn-1' },
      data: { receiptPrinted: true },
      include: { items: true, shift: { select: { id: true, status: true, branchId: true } } },
    });
  });
});
