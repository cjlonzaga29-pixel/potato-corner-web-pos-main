'use client';

import { use } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { useProduct } from '@/hooks/queries/use-products';
import { BranchAvailabilityPanel } from '@/components/products/branch-availability-panel';
import { ProductStatusBadge } from '@/components/admin/products/product-status-badge';
import { SeasonalBadge } from '@/components/admin/products/seasonal-badge';

interface SupervisorProductActivationPageProps {
  params: Promise<{ productId: string }>;
}

export default function SupervisorProductActivationPage({ params }: SupervisorProductActivationPageProps) {
  const { productId } = use(params);
  const { data: product, isLoading, isError, refetch } = useProduct(productId);

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
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/supervisor/products">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to products
        </Link>
      </Button>

      <div className="flex items-center gap-4">
        {product.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- product photo from Supabase Storage
          <img src={product.image_url} alt={product.name} className="h-16 w-16 rounded-md object-cover" />
        ) : (
          <div className="h-16 w-16 rounded-md bg-muted" />
        )}
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{product.name}</h1>
            <ProductStatusBadge status={product.status} />
            <SeasonalBadge isSeasonal={product.is_seasonal} />
          </div>
          <p className="text-sm text-muted-foreground">{product.category ?? 'Uncategorized'}</p>
        </div>
      </div>

      <BranchAvailabilityPanel product={product} />
    </div>
  );
}
