'use client';

import type { ColumnDef } from '@tanstack/react-table';
import type { ShadowBomDeductionDetailRow } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/utils';

const CLASSIFICATION_LABELS: Record<ShadowBomDeductionDetailRow['classification'], string> = {
  MATCH: 'Match',
  BOM_NOT_READY: 'BOM Not Ready',
  MISSING_LEGACY_MAPPING: 'Missing Legacy Mapping',
  MISSING_BOM_COMPONENT: 'Missing BOM Component',
  EXTRA_BOM_COMPONENT: 'Extra BOM Component',
  QUANTITY_MISMATCH: 'Quantity Mismatch',
  UNIT_CONVERSION_UNSUPPORTED: 'Unit Conversion Unsupported',
  FLAVOR_DEPENDENCY: 'Flavor Dependency',
  ERROR: 'Error',
};

/** MATCH is the only "good" outcome; ERROR is a hard failure; BOM_NOT_READY is expected/informational; everything else is a real discrepancy worth flagging. */
export function badgeVariantForClassification(
  classification: ShadowBomDeductionDetailRow['classification'],
): 'active' | 'critical' | 'warning' | 'pending' {
  if (classification === 'MATCH') return 'active';
  if (classification === 'ERROR') return 'critical';
  if (classification === 'BOM_NOT_READY') return 'pending';
  return 'warning';
}

export function classificationLabel(classification: ShadowBomDeductionDetailRow['classification']): string {
  return CLASSIFICATION_LABELS[classification];
}

export const shadowBomDeductionColumns: ColumnDef<ShadowBomDeductionDetailRow>[] = [
  {
    id: 'compared_at',
    header: 'Compared At',
    cell: ({ row }) => formatDateTime(row.original.compared_at),
  },
  {
    id: 'branch_id',
    header: 'Branch',
    cell: ({ row }) => row.original.branch_id,
  },
  {
    id: 'product_variant_id',
    header: 'Product Variant',
    cell: ({ row }) => row.original.product_variant_id,
  },
  {
    id: 'transaction_id',
    header: 'Transaction',
    cell: ({ row }) => row.original.transaction_id,
  },
  {
    id: 'sale_line_id',
    header: 'Sale Line',
    cell: ({ row }) => row.original.sale_line_id,
  },
  {
    id: 'classification',
    header: 'Classification',
    cell: ({ row }) => (
      <Badge variant={badgeVariantForClassification(row.original.classification)}>
        {classificationLabel(row.original.classification)}
      </Badge>
    ),
  },
  {
    id: 'legacy_calculation',
    header: 'Legacy Calculation',
    cell: ({ row }) => (
      <pre className="max-w-xs overflow-x-auto whitespace-pre-wrap text-xs">
        {JSON.stringify(row.original.legacy_calculation, null, 2)}
      </pre>
    ),
  },
  {
    id: 'bom_calculation',
    header: 'BOM Calculation',
    cell: ({ row }) => (
      <pre className="max-w-xs overflow-x-auto whitespace-pre-wrap text-xs">
        {JSON.stringify(row.original.bom_calculation, null, 2)}
      </pre>
    ),
  },
  {
    id: 'error_details',
    header: 'Error Details',
    cell: ({ row }) =>
      row.original.error_details ? (
        <pre className="max-w-xs overflow-x-auto whitespace-pre-wrap text-xs text-destructive">
          {JSON.stringify(row.original.error_details, null, 2)}
        </pre>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
];
