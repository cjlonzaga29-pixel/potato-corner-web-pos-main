import type { ShiftResponse } from '@potato-corner/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCurrency } from '@/lib/utils';

interface ShiftDenominationTableProps {
  denominations: NonNullable<ShiftResponse['denominations']>;
  phase: 'opening' | 'closing';
}

/** Read-only denomination breakdown for the admin shift detail view — unlike apps/web/components/pos/denomination-table.tsx, this never accepts input. */
export function ShiftDenominationTable({ denominations, phase }: ShiftDenominationTableProps) {
  const rows = denominations.filter((d) => d.phase === phase);
  const total = rows.reduce((sum, r) => sum + r.subtotal, 0);

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No {phase} count recorded.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Denomination</TableHead>
          <TableHead>Quantity</TableHead>
          <TableHead className="text-right">Subtotal</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium">{formatCurrency(row.denomination)}</TableCell>
            <TableCell>{row.quantity}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(row.subtotal)}</TableCell>
          </TableRow>
        ))}
        <TableRow>
          <TableCell colSpan={2} className="font-semibold">
            Total
          </TableCell>
          <TableCell className="text-right font-semibold tabular-nums">{formatCurrency(total)}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}
