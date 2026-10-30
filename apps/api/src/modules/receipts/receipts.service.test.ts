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
          discountAmount: decimal(0),
          promotionSnapshot: null,
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
      {
        product_name: 'Regular',
        variant_name: 'Solo',
        flavor_name: 'Cheese',
        quantity: 2,
        unit_price: 65,
        line_total: 130,
        selected_options: [],
        discount_amount: 0,
        promotion_name: null,
      },
    ]);
    expect(result.total_amount).toBe(130);
    expect(result.cash_tendered).toBe(150);
    expect(result.change_given).toBe(20);
  });

  // Task 93 — the public e-receipt must surface selected Product Options
  // (name + price adjustment only, never inventory/group IDs — this response
  // is unauthenticated and customer-facing).
  it('maps a persisted selectedOptions snapshot to selected_options on the item', async () => {
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
          quantity: 1,
          unitPriceSnapshot: decimal(74),
          lineTotal: decimal(74),
          discountAmount: decimal(0),
          selectedOptions: [
            { optionId: 'option-cheese', optionName: 'Extra Cheese', optionGroupId: 'group-1', optionGroupName: 'Add-ons', priceAdjustment: 15 },
          ],
        },
      ],
      subtotal: decimal(74),
      discountAmount: decimal(0),
      discountType: null,
      vatAmount: decimal(7.93),
      totalAmount: decimal(74),
      amountTendered: decimal(100),
      changeAmount: decimal(26),
      gcashReference: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await receiptsService.getPublicReceipt('MNL001-20260714-000001');

    expect(result.items[0]?.selected_options).toEqual([{ option_name: 'Extra Cheese', price_adjustment: 15 }]);
  });

  // POS-PERF-P49 — the line's frozen promotion name and discount, never the live promotion row.
  it('maps a frozen promotion snapshot to discount_amount and promotion_name, keeping line_total gross', async () => {
    vi.mocked(receiptsRepository.findByTransactionNumber).mockResolvedValue({
      transactionNumber: 'MNL001-20261030-000002',
      status: 'completed',
      paymentMethod: 'cash',
      createdAt: new Date('2026-10-30T10:00:00Z'),
      branch: { name: 'Manila - Robinsons' },
      items: [
        {
          productNameSnapshot: 'Promo Fries',
          variantNameSnapshot: 'Regular',
          flavorNameSnapshot: null,
          quantity: 3,
          unitPriceSnapshot: decimal(39),
          lineTotal: decimal(117),
          discountAmount: decimal(30),
          promotionSnapshot: { promotion_id: 'p-1', name: 'Ten Off', discount_kind: 'fixed_amount', discount_value: 10, version: 1, base_price: 39, unit_discount: 10, quantity: 3 },
        },
      ],
      subtotal: decimal(117),
      discountAmount: decimal(30),
      discountType: 'promotional',
      vatAmount: decimal(9.32),
      totalAmount: decimal(87),
      amountTendered: decimal(100),
      changeAmount: decimal(13),
      gcashReference: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await receiptsService.getPublicReceipt('MNL001-20261030-000002');

    expect(result.items[0]).toMatchObject({ line_total: 117, discount_amount: 30, promotion_name: 'Ten Off' });
    expect(result.discount_type).toBe('promotional');
    expect(result.subtotal - result.discount_amount).toBe(result.total_amount);
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
