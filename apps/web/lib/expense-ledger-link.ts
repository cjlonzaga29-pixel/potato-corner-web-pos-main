interface ExpenseLedgerLinkFilters {
  branchId?: string;
  dateFrom?: string;
  dateTo?: string;
  expenseTypeId?: string;
  category?: string;
}

/** POS-PERF-P60 — a filtered ledger's URL. Both ledger pages read these same query parameters. */
export function expenseLedgerHref(path: string, filters: ExpenseLedgerLinkFilters): string {
  const params = new URLSearchParams();
  if (filters.branchId) params.set('branch_id', filters.branchId);
  if (filters.dateFrom) params.set('date_from', filters.dateFrom);
  if (filters.dateTo) params.set('date_to', filters.dateTo);
  if (filters.expenseTypeId) params.set('expense_type_id', filters.expenseTypeId);
  if (filters.category) params.set('category', filters.category);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
