import { receiptsRepository } from './receipts.repository.js';
import { LEGACY_VAT_CALCULATION, resolveCalculationMode } from '@potato-corner/shared';
import { ReceiptError, type PublicReceiptResponse } from './receipts.types.js';
import type { SelectedOptionSnapshot } from '../transactions/transactions.repository.js';

/** POS-PERF-P49 — the frozen promotion name from TransactionItem.promotionSnapshot, never the live promotion row. P55 reuses it for the manual discount snapshot's name. */
function promotionName(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const name = (snapshot as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

/**
 * Receipts business logic. Called by the router after Zod validation;
 * never calls Prisma directly — always goes through receiptsRepository.
 */
export const receiptsService = {
  async getPublicReceipt(transactionNumber: string): Promise<PublicReceiptResponse> {
    const transaction = await receiptsRepository.findByTransactionNumber(transactionNumber);
    if (!transaction) throw new ReceiptError('RECEIPT_NOT_FOUND', 'Receipt not found', 404);
    // POS-PERF-P55R2 — a manual-total sale has no VAT figures (null, not ₱0).
    const calculationMode = resolveCalculationMode(transaction.calculationMode);
    const vatCalculated = calculationMode === LEGACY_VAT_CALCULATION;

    return {
      receipt_number: transaction.transactionNumber,
      branch_name: transaction.branch.name,
      status: transaction.status as PublicReceiptResponse['status'],
      created_at: transaction.createdAt.toISOString(),
      items: transaction.items.map((item) => ({
        product_name: item.productNameSnapshot,
        variant_name: item.variantNameSnapshot,
        flavor_name: item.flavorNameSnapshot,
        quantity: item.quantity,
        unit_price: item.unitPriceSnapshot.toNumber(),
        line_total: item.lineTotal.toNumber(),
        selected_options: ((item.selectedOptions as SelectedOptionSnapshot[] | null) ?? []).map((option) => ({
          option_name: option.optionName,
          price_adjustment: option.priceAdjustment,
        })),
        discount_amount: item.discountAmount.toNumber(),
        promotion_name: promotionName(item.promotionSnapshot),
      })),
      subtotal: transaction.subtotal.toNumber(),
      discount_amount: transaction.discountAmount.toNumber(),
      discount_type: transaction.discountType,
      manual_discount_name: promotionName(transaction.manualDiscountSnapshot),
      discount_rate_used: transaction.discountRateUsed?.toNumber() ?? null,
      calculation_mode: calculationMode,
      vat_amount: vatCalculated ? transaction.vatAmount.toNumber() : null,
      vat_exempt_amount: vatCalculated ? transaction.vatExemptAmount.toNumber() : null,
      total_amount: transaction.totalAmount.toNumber(),
      payment_method: transaction.paymentMethod,
      cash_tendered: transaction.amountTendered?.toNumber() ?? null,
      change_given: transaction.changeAmount?.toNumber() ?? null,
      gcash_reference_number: transaction.gcashReference,
    };
  },
};
