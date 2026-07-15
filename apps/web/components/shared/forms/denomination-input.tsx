'use client';

import { useMemo } from 'react';
import { PHILIPPINE_DENOMINATIONS, DENOMINATION_LABELS } from '@/lib/constants';
import { formatCurrency } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface DenominationEntry {
  denomination: number;
  count: number;
  total_value: number;
}

interface DenominationInputProps {
  value: DenominationEntry[];
  onChange: (entries: DenominationEntry[], total: number) => void;
}

/** Cents, rounded, to avoid float drift on 0.25/0.10/0.05/0.01 denominations. */
function toCents(denomination: number): number {
  return Math.round(denomination * 100);
}

function buildEntries(value: DenominationEntry[]): DenominationEntry[] {
  return PHILIPPINE_DENOMINATIONS.map((denomination) => {
    const existing = value.find((entry) => entry.denomination === denomination);
    return existing ?? { denomination, count: 0, total_value: 0 };
  });
}

function sumCents(entries: DenominationEntry[]): number {
  return entries.reduce((sum, entry) => sum + toCents(entry.denomination) * entry.count, 0);
}

/**
 * Business-critical cash-count grid. Every calculation is done in integer
 * centavos (Math.round(denomination * 100) * count) and only converted
 * back to pesos for display/emission — plain float multiplication on
 * 0.25/0.10/0.05/0.01 denominations accumulates rounding error across a
 * full drawer count, which this component cannot afford to get wrong.
 */
export function DenominationInput({ value, onChange }: DenominationInputProps) {
  const entries = useMemo(() => buildEntries(value), [value]);
  const grandTotal = sumCents(entries) / 100;

  function handleCountChange(denomination: number, rawCount: string) {
    const count = Math.max(0, Math.floor(Number(rawCount) || 0));
    const next = entries.map((entry) =>
      entry.denomination === denomination
        ? { ...entry, count, total_value: (toCents(denomination) * count) / 100 }
        : entry,
    );
    onChange(next, sumCents(next) / 100);
  }

  const bills = entries.filter((entry) => entry.denomination >= 20);
  const coins = entries.filter((entry) => entry.denomination >= 1 && entry.denomination < 20);
  const centavos = entries.filter((entry) => entry.denomination < 1);

  function renderRow(entry: DenominationEntry) {
    return (
      <div key={entry.denomination} className="grid grid-cols-3 items-center gap-3">
        <Label htmlFor={`denom-${entry.denomination}`} className="text-sm font-medium">
          {DENOMINATION_LABELS[entry.denomination]}
        </Label>
        <Input
          id={`denom-${entry.denomination}`}
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          className="h-12 min-h-[48px] text-center text-base"
          value={entry.count === 0 ? '' : entry.count}
          onChange={(event) => handleCountChange(entry.denomination, event.target.value)}
          placeholder="0"
        />
        <span className="text-right text-sm tabular-nums text-muted-foreground">
          {formatCurrency(entry.total_value)}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm font-semibold text-muted-foreground">Bills</p>
        {bills.map(renderRow)}
      </div>
      <div className="space-y-2">
        <p className="text-sm font-semibold text-muted-foreground">Coins</p>
        {coins.map(renderRow)}
      </div>
      <div className="space-y-2">
        <p className="text-sm font-semibold text-muted-foreground">Centavos</p>
        {centavos.map(renderRow)}
      </div>
      <div className="flex items-center justify-between border-t pt-4">
        <span className="text-base font-semibold">Grand Total</span>
        <span className="text-lg font-bold tabular-nums">{formatCurrency(grandTotal)}</span>
      </div>
    </div>
  );
}
