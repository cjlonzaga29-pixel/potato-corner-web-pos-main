'use client';

import type { ExpenseSummaryResponse, ExpenseTypeResponse } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { cn, formatCurrency } from '@/lib/utils';

export type ExpenseLedgerView = { kind: 'all' } | { kind: 'type'; id: string } | { kind: 'legacy'; category?: string };

interface ExpenseTypeBoardProps {
  types: ExpenseTypeResponse[];
  /** Undefined while loading or after a failure: cards then show "—", never a false 0. */
  summary: ExpenseSummaryResponse | undefined;
  view: ExpenseLedgerView;
  onSelect: (view: ExpenseLedgerView) => void;
}

interface BoardCard {
  key: string;
  label: string;
  view: ExpenseLedgerView;
  count: number | null;
  amount: number | null;
  deactivated: boolean;
}

function buildCards(types: ExpenseTypeResponse[], summary: ExpenseSummaryResponse | undefined): BoardCard[] {
  const typeGroups = summary?.groups.filter((group) => group.kind === 'type') ?? [];
  const legacyGroups = summary?.groups.filter((group) => group.kind === 'legacy') ?? [];
  const fromTypes: BoardCard[] = types.map((type) => {
    const group = typeGroups.find((g) => g.expense_type_id === type.id);
    return {
      key: type.id,
      label: type.name,
      view: { kind: 'type', id: type.id },
      count: summary ? (group?.count ?? 0) : null,
      amount: summary ? (group?.total_amount ?? 0) : null,
      deactivated: !type.is_active,
    };
  });
  // An expense can only be counted if its type has a card, even one this list didn't return.
  const unlisted: BoardCard[] = typeGroups
    .filter((group) => !types.some((type) => type.id === group.expense_type_id))
    .map((group) => ({
      key: group.key,
      label: group.name,
      view: { kind: 'type', id: group.expense_type_id as string },
      count: group.count,
      amount: group.total_amount,
      deactivated: group.is_active === false,
    }));
  const named = [...fromTypes, ...unlisted].sort((a, b) => Number(a.deactivated) - Number(b.deactivated) || a.label.localeCompare(b.label));
  const legacy: BoardCard[] = legacyGroups.length
    ? [
        {
          key: 'legacy',
          label: 'Legacy / Unassigned',
          view: { kind: 'legacy' },
          count: legacyGroups.reduce((sum, group) => sum + group.count, 0),
          amount: legacyGroups.reduce((cents, group) => cents + Math.round(group.total_amount * 100), 0) / 100,
          deactivated: false,
        },
      ]
    : [];
  return [
    { key: 'all', label: 'All Expenses', view: { kind: 'all' }, count: summary?.total ?? null, amount: summary?.total_amount ?? null, deactivated: false },
    ...named,
    ...legacy,
  ];
}

function isSelected(card: BoardCard, view: ExpenseLedgerView): boolean {
  if (card.view.kind !== view.kind) return false;
  return card.view.kind !== 'type' || (view.kind === 'type' && card.view.id === view.id);
}

/**
 * POS-PERF-P60 — one compact card per view of the single ledger, each with the same
 * server-side filters as the rows beneath it. Scrolls within itself past a few rows,
 * so many types neither push the ledger away nor widen a phone's page.
 */
export function ExpenseTypeBoard({ types, summary, view, onSelect }: ExpenseTypeBoardProps) {
  return (
    <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto p-0.5 sm:grid-cols-3 lg:grid-cols-4" role="group" aria-label="Expense views" data-testid="expense-type-board">
      {buildCards(types, summary).map((card) => (
        <button
          key={card.key}
          type="button"
          aria-pressed={isSelected(card, view)}
          onClick={() => onSelect(card.view)}
          className={cn(
            'min-w-0 rounded-md border bg-card p-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            isSelected(card, view) && 'border-primary ring-1 ring-primary',
            card.deactivated && 'opacity-80',
          )}
        >
          <span className="block truncate text-sm font-medium" title={card.label}>
            {card.label}
          </span>
          <span className="mt-1 block truncate font-semibold tabular-nums">{card.amount === null ? '—' : formatCurrency(card.amount)}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {card.count === null ? 'Total unavailable' : `${card.count} ${card.count === 1 ? 'record' : 'records'}`}
            {card.deactivated && <Badge variant="inactive">Deactivated</Badge>}
          </span>
        </button>
      ))}
    </div>
  );
}
