export interface PublicReceiptSelectedOption {
  option_name: string;
  price_adjustment: number;
}

export interface PublicReceiptItem {
  product_name: string;
  variant_name: string;
  flavor_name: string | null;
  quantity: number;
  unit_price: number;
  line_total: number;
  selected_options: PublicReceiptSelectedOption[];
  /** POS-PERF-P49 — this line's promotion discount (0 when none); line_total stays gross. */
  discount_amount: number;
  /** POS-PERF-P49 — frozen promotion name, or null. */
  promotion_name: string | null;
}

/**
 * Fields shown on the public, unauthenticated `/r/[txn]` receipt view — the
 * digital counterpart of the printed receipt (architecture doc:
 * transaction_number IS the receipt number, same value everywhere).
 * Deliberately excludes anything not already on the paper receipt: no
 * cashier identity, no discount_id_reference, no internal ids.
 */
export interface PublicReceiptResponse {
  receipt_number: string;
  branch_name: string;
  status: 'completed' | 'voided' | 'refunded';
  created_at: string;
  items: PublicReceiptItem[];
  subtotal: number;
  discount_amount: number;
  discount_type: string | null;
  /** POS-PERF-P55 — the manual discount type's name as frozen on the sale; null for every other sale. */
  manual_discount_name?: string | null;
  // Task 209.xx — the configured percentage actually applied at sale time,
  // frozen on the transaction row; never today's Discount Settings value.
  discount_rate_used?: number | null;
  /** POS-PERF-P55R2 — 'manual_total_v1': VAT not calculated, so both VAT fields are null. */
  calculation_mode: 'legacy_vat_v1' | 'manual_total_v1';
  vat_amount: number | null;
  /** POS-PERF-P50 — stored non-VATable portion (VAT-cap overflow), for the receipt's tax breakdown. */
  vat_exempt_amount: number | null;
  total_amount: number;
  payment_method: string;
  cash_tendered: number | null;
  change_given: number | null;
  gcash_reference_number: string | null;
}

export class ReceiptError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'ReceiptError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
