/**
 * POS-PERF-P50 — the one VAT/discount calculation for a sale. The API's
 * checkout (transactions.service.ts computeAmounts) is the authority and
 * persists the result; the POS preview runs this same function so the amount
 * the cashier confirms is computed the same way. Moved here unchanged from
 * computeAmounts/previewAmounts, which had diverged into two copies.
 *
 * Statutory values (see docs/runbooks/pos-perf-p50-vat-settings-and-calculation-review.md
 * for sources) are constants, not settings: changing one is a code release,
 * and stored sales keep the amounts computed when they were rung.
 */

/** VAT rate, percent. NIRC §106 as amended by RA 10963 (TRAIN): 12%. */
export const VAT_RATE_PERCENT = 12;

/** PWD (RA 10754 §5, "at least 20%") and Senior Citizen (RA 9994 §4(a), "20%") discount, percent. */
export const STATUTORY_DISCOUNT_PERCENT = 20;

/** Menu and catalog prices already include VAT (application behavior, not configurable). */
export const PRICES_INCLUDE_VAT = true;

/** Discount types whose sales are VAT-exempt (RA 9994 / RA 10754): VAT is never charged. */
export const VAT_EXEMPT_DISCOUNT_TYPES = ['pwd', 'senior_citizen'] as const;

const VAT_DIVISOR = (100 + VAT_RATE_PERCENT) / 100;
const VAT_SHARE_OF_INCLUSIVE = VAT_RATE_PERCENT / (100 + VAT_RATE_PERCENT);

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export interface SaleTaxLine {
  /** Gross VAT-inclusive line total (unit price × quantity, before any discount). */
  lineTotal: number;
  quantity: number;
  /** Per-unit VATable ceiling; the part of the line above it is non-VATable. Null = whole line VATable. */
  vatableCapAmount: number | null;
  /** POS-PERF-P49 product promotion for the whole line (only with no transaction-level discount). */
  promotionDiscount?: number;
}

export interface SaleDiscountRates {
  pwd: number;
  senior_citizen: number;
  employee: number;
}

export interface SaleTaxAmounts {
  discountAmount: number;
  vatAmount: number;
  /** Non-VATable portion of the subtotal (VAT-cap overflow). Not the VAT-exempt sale amount of a PWD/Senior sale. */
  vatExemptAmount: number;
  totalAmount: number;
  /** The percentage applied for a rate-based discount type, else null. */
  discountRateUsed: number | null;
}

export type SaleDiscountType = 'pwd' | 'senior_citizen' | 'employee' | 'manager_override' | 'promotional' | null | undefined;

export function isVatExemptDiscountType(discountType: string | null | undefined): boolean {
  return discountType === 'pwd' || discountType === 'senior_citizen';
}

/** The rate a sale of this type would apply under the given rates, or null when no rate-based discount applies. */
export function discountRateFor(discountType: SaleDiscountType, rates: SaleDiscountRates): number | null {
  if (discountType === 'pwd') return rates.pwd;
  if (discountType === 'senior_citizen') return rates.senior_citizen;
  if (discountType === 'employee') return rates.employee;
  return null;
}

/**
 * PWD/Senior Citizen: true VAT-exempt sale — VAT is removed from the VATable
 * part (÷ 1.12), the discount is taken from that VAT-exclusive amount and no
 * VAT is added back. Everything else: prices are VAT-inclusive, the discount
 * (Employee %, or P49 product promotions) comes off the VATable amount and
 * VAT is the 12/112 share of what remains. The non-VATable part is never
 * discounted or taxed.
 */
export function computeSaleTax(
  subtotal: number,
  lines: readonly SaleTaxLine[],
  discountType: SaleDiscountType,
  rates: SaleDiscountRates,
): SaleTaxAmounts {
  const vatableSubtotal = round2(
    lines.reduce((sum, line) => {
      const cap = line.vatableCapAmount;
      const vatableLine = cap != null ? Math.min(line.lineTotal, round2(cap * line.quantity)) : line.lineTotal;
      return sum + vatableLine;
    }, 0),
  );
  const nonVatableSubtotal = round2(subtotal - vatableSubtotal);

  if (discountType === 'pwd' || discountType === 'senior_citizen') {
    const ratePercent = discountType === 'pwd' ? rates.pwd : rates.senior_citizen;
    const vatableBase = vatableSubtotal / VAT_DIVISOR;
    const discountAmount = round2(vatableBase * (ratePercent / 100));
    const discountedBase = round2(vatableBase - discountAmount);
    const totalAmount = round2(discountedBase + nonVatableSubtotal);
    return { discountAmount, vatAmount: 0, vatExemptAmount: nonVatableSubtotal, totalAmount, discountRateUsed: ratePercent };
  }

  let discountAmount = 0;
  let discountRateUsed: number | null = null;
  if (discountType === 'employee') {
    discountRateUsed = rates.employee;
    discountAmount = round2(vatableSubtotal * (discountRateUsed / 100));
  } else if (!discountType) {
    discountAmount = round2(lines.reduce((sum, line) => sum + (line.promotionDiscount ?? 0), 0));
  }
  const vatableAfterDiscount = round2(vatableSubtotal - discountAmount);
  const vatAmount = round2(vatableAfterDiscount * VAT_SHARE_OF_INCLUSIVE);
  const totalAmount = round2(vatableAfterDiscount + nonVatableSubtotal);
  return { discountAmount, vatAmount, vatExemptAmount: nonVatableSubtotal, totalAmount, discountRateUsed };
}

export interface StoredSaleTax {
  discount_type: string | null;
  vat_amount: number;
  vat_exempt_amount: number;
  total_amount: number;
}

export interface SaleTaxBreakdown {
  /** VATable sales net of VAT (0 for a VAT-exempt sale). */
  vatableSales: number;
  vatAmount: number;
  /** Whole amount of a PWD/Senior Citizen sale (VAT-exempt by statute). */
  vatExemptSales: number;
  /** VAT-cap overflow on an ordinary sale. */
  nonVatableAmount: number;
  isVatExemptSale: boolean;
}

/**
 * Display breakdown for a recorded sale, derived only from the amounts stored
 * on that sale — never from current settings — so a receipt or report reads
 * the same no matter what changes later.
 */
export function describeStoredSaleTax(sale: StoredSaleTax): SaleTaxBreakdown {
  if (isVatExemptDiscountType(sale.discount_type)) {
    return { vatableSales: 0, vatAmount: sale.vat_amount, vatExemptSales: sale.total_amount, nonVatableAmount: 0, isVatExemptSale: true };
  }
  return {
    vatableSales: round2(sale.total_amount - sale.vat_exempt_amount - sale.vat_amount),
    vatAmount: sale.vat_amount,
    vatExemptSales: 0,
    nonVatableAmount: sale.vat_exempt_amount,
    isVatExemptSale: false,
  };
}
