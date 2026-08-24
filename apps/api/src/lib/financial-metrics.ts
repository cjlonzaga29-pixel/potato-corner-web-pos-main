function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface FinancialMetricsInput {
  /** Sum of original completed-sale item values before discounts (Transaction.subtotal). */
  grossSales: number;
  /** Sum of valid discounts applied to completed transactions. */
  discountTotal: number;
  /** Value of refunded completed sales (Transaction.totalAmount where status = refunded). */
  refundTotal: number;
  /** Sum of logged expenses for the same period/branch scope. */
  expenseTotal: number;
}

export interface FinancialMetrics {
  grossSales: number;
  discountTotal: number;
  refundTotal: number;
  netSales: number;
  expenseTotal: number;
  netOperatingResult: number;
}

/**
 * The one formula set every dashboard/report reads from — P2 Canonical
 * Finance Simplification. Net Sales = Gross Sales - Discounts - Refunds;
 * Net Operating Result = Net Sales - Operating Expenses. Inventory cost
 * (COGS, waste valuation) is deliberately excluded from this formula: the
 * owner-approved operational model does not derive profitability from
 * inventory cost. Receiving/waste/adjustments/transfers remain inventory
 * quantity events only and never affect this figure — see lib/cogs.ts,
 * which still exists for non-finance inventory-valuation reporting but is
 * no longer read by this function. VAT is never subtracted a second time
 * here: Transaction.totalAmount (and therefore grossSales - discountTotal,
 * its equivalent) is already VAT-inclusive pricing with the VAT component
 * merely extracted for display, not added on top.
 */
export function computeFinancialMetrics(input: FinancialMetricsInput): FinancialMetrics {
  const grossSales = round2(input.grossSales);
  const discountTotal = round2(input.discountTotal);
  const refundTotal = round2(input.refundTotal);
  const expenseTotal = round2(input.expenseTotal);

  const netSales = round2(grossSales - discountTotal - refundTotal);
  const netOperatingResult = round2(netSales - expenseTotal);

  return { grossSales, discountTotal, refundTotal, netSales, expenseTotal, netOperatingResult };
}
