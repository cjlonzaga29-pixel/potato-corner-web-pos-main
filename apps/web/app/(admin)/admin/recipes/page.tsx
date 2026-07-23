'use client';

import { useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { ArrowLeft, ChevronDown } from 'lucide-react';
import type { ProductResponse, ProductVariantResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DataTable } from '@/components/shared/data-table';
import { SearchInput } from '@/components/shared/forms/search-input';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { cn, formatDateTime } from '@/lib/utils';
import { useProducts, useProduct } from '@/hooks/queries/use-products';
import { useRecipesList } from '@/hooks/queries/use-recipes';

/**
 * The recipes API has no aggregate "recipe" entity or list-all endpoint —
 * GET /recipes requires a product_variant_id. This page drills down
 * product -> variant -> ingredient lines instead of listing recipes flat.
 */
export default function AdminRecipesPage() {
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Master Recipes</h1>
        <p className="text-sm text-muted-foreground">
          Master recipes for inventory deduction. Supervisors manage branch-level recipe overrides separately.
        </p>
      </div>

      {selectedProductId ? (
        <VariantRecipesView productId={selectedProductId} onBack={() => setSelectedProductId(null)} />
      ) : (
        <ProductPicker onSelect={setSelectedProductId} />
      )}
    </div>
  );
}

function ProductPicker({ onSelect }: { onSelect: (productId: string) => void }) {
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
  const { data, isLoading, isError, refetch } = useProducts({
    search: search || undefined,
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns: ColumnDef<ProductResponse>[] = [
    { accessorKey: 'name', header: 'Product' },
    { accessorKey: 'category', header: 'Category', cell: ({ row }) => row.original.category ?? '—' },
    { accessorKey: 'active_variant_count', header: 'Variants' },
    { id: 'updated_at', header: 'Updated', cell: ({ row }) => formatDateTime(row.original.updated_at) },
    {
      id: 'actions',
      cell: ({ row }) => (
        <Button
          variant="outline"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            onSelect(row.original.id);
          }}
        >
          View Recipes
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <SearchInput
        value={search}
        onChange={(value) => {
          setSearch(value);
          setPagination((prev) => ({ ...prev, pageIndex: 0 }));
        }}
        placeholder="Search products..."
        className="max-w-xs"
      />
      <DataTable
        columns={columns}
        data={data?.products ?? []}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => void refetch()}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        onRowClick={(product) => onSelect(product.id)}
        emptyState={<EmptyState title="No products yet" description="Create a product first, then define its master recipe here." />}
      />
    </div>
  );
}

function VariantRecipesView({ productId, onBack }: { productId: string; onBack: () => void }) {
  const { data: product, isLoading, isError, refetch } = useProduct(productId);
  const [expandedVariantId, setExpandedVariantId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (isError || !product) {
    return <ErrorState title="Product not found" retry={() => void refetch()} />;
  }

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to products
      </Button>

      <h2 className="text-lg font-semibold">{product.name}</h2>

      {product.variants.length === 0 ? (
        <EmptyState title="No variants yet" description="Add a variant to this product before defining a recipe." />
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {product.variants.map((variant) => (
            <VariantRecipeCard
              key={variant.id}
              variant={variant}
              expanded={expandedVariantId === variant.id}
              onToggle={() => setExpandedVariantId((prev) => (prev === variant.id ? null : variant.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function VariantRecipeCard({
  variant,
  expanded,
  onToggle,
}: {
  variant: ProductVariantResponse;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { data: lines, isLoading } = useRecipesList(expanded ? variant.id : undefined);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">
          {variant.name} — {variant.size_label}
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={onToggle}>
          View Recipe
          <ChevronDown className={cn('ml-2 h-4 w-4 transition-transform', expanded && 'rotate-180')} />
        </Button>
      </CardHeader>
      {expanded && (
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-6">
              <LoadingSpinner size="sm" />
            </div>
          ) : !lines || lines.length === 0 ? (
            <EmptyState title="No ingredient lines yet" description="This variant's master recipe has not been defined." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ingredient</TableHead>
                  <TableHead>Applies To</TableHead>
                  <TableHead>Quantity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell>{line.ingredient_name}</TableCell>
                    <TableCell>{line.flavor_name ?? 'Base (all flavors)'}</TableCell>
                    <TableCell>
                      {line.quantity} {line.unit}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      )}
    </Card>
  );
}
