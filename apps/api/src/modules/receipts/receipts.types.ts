export interface PublicReceiptItem {
  product_name: string;
  variant_name: string;
  flavor_name: string | null;
  quantity: number;
  unit_price: number;
  line_total: number;
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
  vat_amount: number;
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
