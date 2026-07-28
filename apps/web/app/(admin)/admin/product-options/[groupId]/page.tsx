'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2 } from 'lucide-react';
import type { ProductOptionResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { useProductOptionGroup, useUpdateProductOption } from '@/hooks/queries/use-product-options';
import { CreateOptionDialog } from '@/components/admin/product-options/create-option-dialog';

function OptionRow({ groupId, option }: { groupId: string; option: ProductOptionResponse }) {
  const updateOption = useUpdateProductOption(groupId, option.id);

  return (
    <div className="flex items-center justify-between rounded-md border p-3">
      <div>
        <p className="text-sm font-medium">{option.name}</p>
        <p className="text-xs text-muted-foreground">
          {option.code} · {option.price_adjustment >= 0 ? '+' : ''}
          {option.price_adjustment.toFixed(2)}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Badge variant={option.is_active ? 'active' : 'inactive'}>{option.is_active ? 'Active' : 'Inactive'}</Badge>
        <Switch
          checked={option.is_active}
          disabled={updateOption.isPending}
          onCheckedChange={(checked) => void updateOption.mutateAsync({ is_active: checked })}
        />
      </div>
    </div>
  );
}

export default function ProductOptionGroupDetailPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = use(params);
  const router = useRouter();
  const [createOptionOpen, setCreateOptionOpen] = useState(false);

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
    <div className="space-y-6">
      <Button variant="ghost" size="sm" onClick={() => router.push('/admin/product-options')} className="-ml-2">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back to Option Groups
      </Button>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{group.name}</h1>
          <p className="text-sm text-muted-foreground">
            {group.code} · {group.selection_type === 'SINGLE' ? 'Single selection' : 'Multiple selection'} · min {group.min_selections} / max{' '}
            {group.max_selections ?? '∞'}
          </p>
        </div>
        <Button onClick={() => setCreateOptionOpen(true)}>Add Option</Button>
      </div>

      <div className="space-y-2">
        {group.options.length === 0 ? (
          <EmptyState title="No options yet" description="Add the first selectable option for this group." />
        ) : (
          group.options.map((option) => <OptionRow key={option.id} groupId={groupId} option={option} />)
        )}
      </div>

      <CreateOptionDialog groupId={groupId} open={createOptionOpen} onOpenChange={setCreateOptionOpen} />
    </div>
  );
}
