'use client';

import type { ColumnDef } from '@tanstack/react-table';
import type { PosCatalogProduct, PosReadinessCode } from '@potato-corner/shared';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/shared/data-table';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatCurrency } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useCatalog, useCatalogRealtimeSync } from '@/hooks/queries/use-products';

interface CatalogRow {
  productId: string;
  productName: string;
  category: string | null;
  variantId: string;
  variantName: string;
  sizeLabel: string;
  price: number;
  flavorCount: number;
  optionGroupCount: number;
  liveReady: boolean;
  readinessCode: PosReadinessCode;
}

const READINESS_LABELS: Record<PosReadinessCode, string> = {
  READY: 'Ready',
  MISSING_BASE_MAPPING: 'Missing Base Mapping',
  MISSING_FLAVOR_MAPPING: 'Missing Flavor Mapping',
  NOT_AVAILABLE_IN_BRANCH: 'Not Available',
  INACTIVE: 'Inactive',
  PRICE_MISSING: 'Price Missing',
  MIX_MAX_INCOMPLETE: 'Mix & Max Incomplete',
};

// The catalog endpoint (same one the POS Terminal charges against) only
// ever returns variants that are active, branch-available product/variant
// combinations — but that does NOT mean sellable: readiness (below) reflects
// whether ProductInventory has actually been provisioned, so a row here can
// still be non-Ready.
function flattenCatalog(products: PosCatalogProduct[]): CatalogRow[] {
  return products.flatMap((product) =>
    product.variants.map((variant) => ({
      productId: product.id,
      productName: product.name,
      category: product.category,
      variantId: variant.id,
      variantName: variant.name,
      sizeLabel: variant.size_label,
      price: variant.price,
      flavorCount: variant.flavors.length,
      optionGroupCount: variant.option_groups.length,
      liveReady: variant.live_ready,
      readinessCode: variant.readiness_code,
    })),
  );
}

const columns: ColumnDef<CatalogRow>[] = [
  { id: 'productName', header: 'Product', accessorKey: 'productName' },
  { id: 'category', header: 'Category', cell: ({ row }) => row.original.category ?? '—' },
  { id: 'variantName', header: 'Variant', accessorKey: 'variantName' },
  { id: 'sizeLabel', header: 'Size', accessorKey: 'sizeLabel' },
  { id: 'price', header: 'Price', cell: ({ row }) => formatCurrency(row.original.price) },
  {
    id: 'flavorCount',
    header: 'Flavors',
    cell: ({ row }) => (row.original.flavorCount > 0 ? <Badge variant="secondary">{row.original.flavorCount} available</Badge> : '—'),
  },
  {
    id: 'optionGroupCount',
    header: 'Options',
    cell: ({ row }) => (row.original.optionGroupCount > 0 ? <Badge variant="secondary">{row.original.optionGroupCount} groups</Badge> : '—'),
  },
  {
    id: 'liveReady',
    header: 'Live POS Ready',
    cell: ({ row }) => (
      <Badge variant={row.original.liveReady ? 'active' : 'critical'}>{READINESS_LABELS[row.original.readinessCode]}</Badge>
    ),
  },
];

/**
 * Read-only view of this branch's own POS catalog — same data the Terminal
 * charges against (useCatalog), just as a browsable table instead of a
 * tap-to-add grid. Catalog contents, pricing (including branch overrides),
 * and per-branch availability are all managed by Super Admin/Supervisor
 * (admin Products, price overrides, product/flavor requests) — a branch
 * account has no edit capability here today.
 */
export default function BranchProductsPage() {
  const { user } = useAuth();
  const branchId = user?.branchIds[0];
  const { data, isLoading, isError, refetch } = useCatalog(branchId);
  useCatalogRealtimeSync(branchId);

  if (!branchId) {
    return <EmptyState title="No branch assigned" description="Contact your supervisor to get staffed to a branch." />;
  }

  const rows = flattenCatalog(data?.products ?? []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Products</h1>
        <p className="text-sm text-muted-foreground">Your branch&apos;s current catalog, pricing, and availability.</p>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        emptyState={<EmptyState title="No products yet" description="Products assigned to this branch will appear here." />}
      />
    </div>
  );
}
