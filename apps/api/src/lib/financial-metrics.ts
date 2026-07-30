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
  /** Cost of inventory components consumed by valid completed sales — see lib/cogs.ts. */
  cogs: number;
  /** Sum of logged expenses for the same period/branch scope. */
  expenseTotal: number;
}

export interface FinancialMetrics {
  grossSales: number;
  discountTotal: number;
  refundTotal: number;
  netSales: number;
  cogs: number;
  grossProfit: number;
  expenseTotal: number;
  netProfit: number;
}

/**
 * The one formula set every dashboard/report reads from — Simple
 * Operational Audit §2 "Correct financial metrics". VAT is never subtracted
 * a second time here: Transaction.totalAmount (and therefore grossSales -
 * discountTotal, its equivalent) is already VAT-inclusive pricing with the
 * VAT component merely extracted for display, not added on top.
 */
export function computeFinancialMetrics(input: FinancialMetricsInput): FinancialMetrics {
  const grossSales = round2(input.grossSales);
  const discountTotal = round2(input.discountTotal);
  const refundTotal = round2(input.refundTotal);
  const cogs = round2(input.cogs);
  const expenseTotal = round2(input.expenseTotal);

  const netSales = round2(grossSales - discountTotal - refundTotal);
  const grossProfit = round2(netSales - cogs);
  const netProfit = round2(grossProfit - expenseTotal);

  return { grossSales, discountTotal, refundTotal, netSales, cogs, grossProfit, expenseTotal, netProfit };
}
