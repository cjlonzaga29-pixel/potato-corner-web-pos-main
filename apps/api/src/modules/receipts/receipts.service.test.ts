import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./receipts.repository.js', () => ({
  receiptsRepository: {
    findByTransactionNumber: vi.fn(),
  },
}));

const { receiptsRepository } = await import('./receipts.repository.js');
const { receiptsService } = await import('./receipts.service.js');
const { ReceiptError } = await import('./receipts.types.js');

function decimal(value: number) {
  return { toNumber: () => value };
}

describe('receiptsService.getPublicReceipt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps a found transaction to the public receipt shape', async () => {
    vi.mocked(receiptsRepository.findByTransactionNumber).mockResolvedValue({
      transactionNumber: 'MNL001-20260714-000001',
      status: 'completed',
      paymentMethod: 'cash',
      createdAt: new Date('2026-07-14T10:00:00Z'),
      branch: { name: 'Manila - Robinsons' },
      items: [
        {
          productNameSnapshot: 'Regular',
          variantNameSnapshot: 'Solo',
          flavorNameSnapshot: 'Cheese',
          quantity: 2,
          unitPriceSnapshot: decimal(65),
          lineTotal: decimal(130),
        },
      ],
      subtotal: decimal(130),
      discountAmount: decimal(0),
      discountType: null,
      vatAmount: decimal(13.93),
      totalAmount: decimal(130),
      amountTendered: decimal(150),
      changeAmount: decimal(20),
      gcashReference: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await receiptsService.getPublicReceipt('MNL001-20260714-000001');

    expect(result.receipt_number).toBe('MNL001-20260714-000001');
    expect(result.branch_name).toBe('Manila - Robinsons');
    expect(result.items).toEqual([
      { product_name: 'Regular', variant_name: 'Solo', flavor_name: 'Cheese', quantity: 2, unit_price: 65, line_total: 130 },
    ]);
    expect(result.total_amount).toBe(130);
    expect(result.cash_tendered).toBe(150);
    expect(result.change_given).toBe(20);
  });

  it('throws RECEIPT_NOT_FOUND (404) when no transaction matches', async () => {
    vi.mocked(receiptsRepository.findByTransactionNumber).mockResolvedValue(null);

    await expect(receiptsService.getPublicReceipt('does-not-exist')).rejects.toMatchObject({
      code: 'RECEIPT_NOT_FOUND',
      statusCode: 404,
    });
    await expect(receiptsService.getPublicReceipt('does-not-exist')).rejects.toBeInstanceOf(ReceiptError);
  });
});
