'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { SearchInput } from '@/components/shared/forms/search-input';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useProducts } from '@/hooks/queries/use-products';
import { ProductStatusBadge } from '@/components/admin/products/product-status-badge';

export default function SupervisorProductsPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading, isError, refetch } = useProducts({ search: search || undefined, limit: 100 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Product Activation</h1>
        <p className="text-sm text-muted-foreground">Activate or deactivate products for the branches you manage.</p>
      </div>

      <SearchInput value={search} onChange={setSearch} placeholder="Search products..." className="max-w-xs" />

      {isLoading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      ) : isError ? (
        <ErrorState retry={() => void refetch()} />
      ) : !data || data.products.length === 0 ? (
        <EmptyState title="No products found" description="Try a different search." />
      ) : (
        <div className="space-y-2">
          {data.products.map((product) => (
            <Link key={product.id} href={`/supervisor/products/${product.id}`}>
              <Card className="transition-colors hover:bg-accent/40">
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{product.name}</p>
                    <p className="truncate text-sm text-muted-foreground">{product.category ?? 'Uncategorized'}</p>
                  </div>
                  <ProductStatusBadge status={product.status} />
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
