'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2 } from 'lucide-react';
import type { ProductOptionResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ManagedElsewhereBanner } from '@/components/shared/managed-elsewhere-banner';
import { useProductOptionGroup } from '@/hooks/queries/use-product-options';

function OptionRow({ option }: { option: ProductOptionResponse }) {
  return (
    <div className="flex items-center justify-between rounded-md border p-3">
      <div>
        <p className="text-sm font-medium">{option.name}</p>
        <p className="text-xs text-muted-foreground">
          {option.code} · {option.price_adjustment >= 0 ? '+' : ''}
          {option.price_adjustment.toFixed(2)}
        </p>
      </div>
      <Badge variant={option.is_active ? 'active' : 'inactive'}>{option.is_active ? 'Active' : 'Inactive'}</Badge>
    </div>
  );
}

export default function ProductOptionGroupDetailPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = use(params);
  const router = useRouter();

  const { data: group, isLoading } = useProductOptionGroup(groupId);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!group) {
    return <EmptyState title="Option group not found" description="This option group may have been removed." />;
  }

  return (
    <div className="app-section app-section-gap">
      <Button variant="ghost" size="sm" onClick={() => router.push('/admin/product-options')} className="-ml-2">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to Option Groups
      </Button>

      <div>
        <h1 className="app-title font-bold">{group.name}</h1>
        <p className="text-sm text-muted-foreground">
          {group.code} · {group.selection_type === 'SINGLE' ? 'Single selection' : 'Multiple selection'} · min {group.min_selections} / max{' '}
          {group.max_selections ?? '∞'}
        </p>
      </div>

      <ManagedElsewhereBanner module="Product Options" managedBy="Supervisor" />

      <div className="space-y-2">
        {group.options.length === 0 ? (
          <EmptyState title="No options yet" description="Options are added by the supervisor who owns this group." />
        ) : (
          group.options.map((option) => <OptionRow key={option.id} option={option} />)
        )}
      </div>
    </div>
  );
}
