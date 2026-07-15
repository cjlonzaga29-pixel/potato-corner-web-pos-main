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
    },
    transactionItem: { createMany: vi.fn() },
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
  it('creates the transaction row, writes line items, and re-fetches with items+shift included', async () => {
    vi.mocked(prisma.transaction.create).mockResolvedValue({ id: 'txn-1' } as never);
    vi.mocked(prisma.transaction.findUniqueOrThrow).mockResolvedValue({ id: 'txn-1' } as never);

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
      vatAmount: 10.71,
      vatExemptAmount: 0,
      totalAmount: 100,
      cashTendered: 100,
      changeAmount: 0,
      gcashReference: null,
      gcashManuallyVerified: null,
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
      }),
    });
    expect(prisma.transactionItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          transactionId: 'txn-1',
          productId: 'product-1',
          productVariantId: 'variant-1',
          quantity: 1,
          lineTotal: 100,
        }),
      ],
    });
    expect(prisma.transaction.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'txn-1' },
      include: { items: true, shift: { select: { id: true, status: true, branchId: true } } },
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
        where: { createdAt: { gte: new Date('2026-07-01T00:00:00.000Z'), lte: new Date('2026-07-14T23:59:59.999Z') } },
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
