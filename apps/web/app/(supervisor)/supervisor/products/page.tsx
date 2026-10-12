'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Plus } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/shared/forms/search-input';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useProducts } from '@/hooks/queries/use-products';
import { ProductStatusBadge } from '@/components/admin/products/product-status-badge';
import { CreateProductDialog } from '@/components/admin/products/create-product-dialog';

export default function SupervisorProductsPage() {
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading, isError, refetch } = useProducts({ search: search || undefined, limit: 100 });

  return (
    <div className="app-section app-section-gap">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="app-title font-bold">Products</h1>
          <p className="text-sm text-muted-foreground">Create new products, and activate or deactivate existing ones for the branches you manage.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="w-full sm:w-auto">
          <Plus className="mr-2 h-4 w-4" />
          Create Product
        </Button>
      </div>

      <SearchInput value={search} onChange={setSearch} placeholder="Search products..." className="max-w-xs" />

      {isLoading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      ) : isError ? (
        <ErrorState retry={() => void refetch()} />
      ) : !data || data.products.length === 0 ? (
        <EmptyState title="No products found" description={search ? 'Try a different search.' : 'Click Create Product to add the first one.'} />
      ) : (
        <div className="space-y-2">
          {data.products.map((product) => (
            <Link key={product.id} href={`/supervisor/products/${product.id}`}>
              <Card className="transition-colors hover:bg-accent/40">
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{product.name}</p>
                    <p className="truncate text-sm text-muted-foreground">{product.category_name ?? 'Uncategorized'}</p>
                  </div>
                  <ProductStatusBadge status={product.status} />
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <CreateProductDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
