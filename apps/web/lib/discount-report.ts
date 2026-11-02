import {
  discountDisplayName,
  discountIdentityKey,
  discountProofRequirement,
  proofCompletionPercent,
  type DiscountComplianceReportRow,
  type DiscountProofRequirement,
  type TransactionResponse,
} from '@potato-corner/shared';

type SaleDiscountFields = Pick<TransactionResponse, 'discount_type' | 'manual_discount'>;

/** POS-PERF-P59 — the one name every sales list, dialog and report shows; null when the sale has no discount. */
export function saleDiscountName(sale: SaleDiscountFields): string | null {
  return discountDisplayName(sale.discount_type, sale.manual_discount?.name);
}

/** manual_discount is absent when the snapshot is missing or unreadable, which reads as unknown, never as "not required". */
export function saleProofRequirement(sale: SaleDiscountFields): DiscountProofRequirement {
  return discountProofRequirement(sale.discount_type, sale.manual_discount ? sale.manual_discount.require_proof : null);
}

function rowKey(row: DiscountComplianceReportRow): string {
  return row.discount_key ?? discountIdentityKey(row.discount_type, row.discount_type_id);
}

/** An older API omits discount_name; its 'manual' rows then read as unspecified, never as "Manual". */
export function discountRowName(row: DiscountComplianceReportRow): string {
  return row.discount_name ?? discountDisplayName(row.discount_type, null) ?? '';
}

/** One row per branch and discount identity: the API also splits a row by calculation, which these screens do not show. */
export function mergeDiscountRows(rows: DiscountComplianceReportRow[]): DiscountComplianceReportRow[] {
  const merged = new Map<string, DiscountComplianceReportRow>();
  for (const row of rows) {
    const key = `${row.branch_id}|${rowKey(row)}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row, discount_key: rowKey(row), discount_name: discountRowName(row) });
      continue;
    }
    existing.transaction_count += row.transaction_count;
    existing.total_discount_amount = Math.round((existing.total_discount_amount + row.total_discount_amount) * 100) / 100;
    existing.proof_required_count = (existing.proof_required_count ?? 0) + (row.proof_required_count ?? 0);
    existing.proof_available_count = (existing.proof_available_count ?? 0) + (row.proof_available_count ?? 0);
    existing.proof_missing_count = (existing.proof_missing_count ?? 0) + (row.proof_missing_count ?? 0);
    existing.proof_unknown_count = (existing.proof_unknown_count ?? 0) + (row.proof_unknown_count ?? 0);
    existing.discount_other_names = [...new Set([...(existing.discount_other_names ?? []), ...(row.discount_other_names ?? [])])];
  }
  return [...merged.values()].map((row) => ({
    ...row,
    proof_completion_percent: proofCompletionPercent(row.proof_required_count ?? 0, row.proof_available_count ?? 0),
  }));
}

export interface DiscountTypeOption {
  key: string;
  label: string;
}

/**
 * The filter's choices come only from sales in the current branch and date
 * range, so deactivated types still appear and nothing is listed that has no
 * sales. Same-named types are told apart by branch, then by id: they are
 * different types and never share a choice.
 */
export function discountTypeOptions(rows: DiscountComplianceReportRow[]): DiscountTypeOption[] {
  const byKey = new Map<string, { name: string; branches: Set<string> }>();
  for (const row of rows) {
    const key = rowKey(row);
    const entry = byKey.get(key) ?? { name: discountRowName(row), branches: new Set<string>() };
    entry.branches.add(row.branch_name);
    byKey.set(key, entry);
  }
  const nameCounts = new Map<string, number>();
  for (const { name } of byKey.values()) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  const branchNames = new Set(rows.map((row) => row.branch_name));
  return [...byKey.entries()]
    .map(([key, { name, branches }]) => {
      if ((nameCounts.get(name) ?? 0) < 2) return { key, label: name };
      if (branchNames.size > 1) return { key, label: `${name} (${[...branches].join(', ')})` };
      return { key, label: `${name} (#${key.slice(key.indexOf(':') + 1, key.indexOf(':') + 7)})` };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

export interface DiscountProofSummary {
  required: number;
  available: number;
  missing: number;
  unknown: number;
  /** Null means N/A: no sale in these rows required proof. */
  completionPercent: number | null;
}

export function summarizeDiscountProof(rows: DiscountComplianceReportRow[]): DiscountProofSummary {
  const required = rows.reduce((sum, row) => sum + (row.proof_required_count ?? 0), 0);
  const available = rows.reduce((sum, row) => sum + (row.proof_available_count ?? 0), 0);
  return {
    required,
    available,
    missing: rows.reduce((sum, row) => sum + (row.proof_missing_count ?? 0), 0),
    unknown: rows.reduce((sum, row) => sum + (row.proof_unknown_count ?? 0), 0),
    completionPercent: proofCompletionPercent(required, available),
  };
}
