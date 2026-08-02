'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, Loader2, Pencil, Settings2, TriangleAlert, X } from 'lucide-react';
import type { ProductOptionResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import {
  useProductOptionGroup,
  useProductOptionDeductionStatus,
  useUpdateProductOption,
} from '@/hooks/queries/use-product-options';
import { CreateOptionDialog } from '@/components/admin/product-options/create-option-dialog';
import { EditOptionDialog } from '@/components/admin/product-options/edit-option-dialog';
import { ManageOptionDeductionDialog } from '@/components/admin/product-options/manage-option-deduction-dialog';

const DEDUCTION_STATUS_DISPLAY = {
  configured: { label: 'Configured', variant: 'active' as const, Icon: Check },
  partial: { label: 'Partial', variant: 'warning' as const, Icon: TriangleAlert },
  not_configured: { label: 'Not Configured', variant: 'critical' as const, Icon: X },
};

function DeductionStatusBadge({ groupId, optionId }: { groupId: string; optionId: string }) {
  const { status, configuredCount, totalCount, isLoading } = useProductOptionDeductionStatus(groupId, optionId);

  if (isLoading) {
    return (
      <Badge variant="inactive" className="gap-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking
      </Badge>
    );
  }

  const { label, variant, Icon } = DEDUCTION_STATUS_DISPLAY[status];

  return (
    <Badge variant={variant} className="gap-1" title={`${configuredCount}/${totalCount} assigned variants configured`}>
      <Icon className="h-3 w-3" />
      {label}
      <span className="opacity-75">
        ({configuredCount}/{totalCount})
      </span>
    </Badge>
  );
}

function OptionRow({
  groupId,
  option,
  onEdit,
  onManageDeduction,
}: {
  groupId: string;
  option: ProductOptionResponse;
  onEdit: (option: ProductOptionResponse) => void;
  onManageDeduction: (option: ProductOptionResponse) => void;
}) {
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
        <DeductionStatusBadge groupId={groupId} optionId={option.id} />
        <Button variant="outline" size="sm" aria-label={`Manage deduction for ${option.name}`} onClick={() => onManageDeduction(option)}>
          <Settings2 className="mr-1 h-4 w-4" />
          Manage Deduction
        </Button>
        <Button variant="outline" size="sm" aria-label={`Edit ${option.name}`} onClick={() => onEdit(option)}>
          <Pencil className="mr-1 h-4 w-4" />
          Edit
        </Button>
      </div>
    </div>
  );
}

export default function ProductOptionGroupDetailPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = use(params);
  const router = useRouter();
  const [createOptionOpen, setCreateOptionOpen] = useState(false);
  const [editingOption, setEditingOption] = useState<ProductOptionResponse | null>(null);
  const [deductionOption, setDeductionOption] = useState<ProductOptionResponse | null>(null);

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
          group.options.map((option) => (
            <OptionRow
              key={option.id}
              groupId={groupId}
              option={option}
              onEdit={setEditingOption}
              onManageDeduction={setDeductionOption}
            />
          ))
        )}
      </div>

      <CreateOptionDialog groupId={groupId} open={createOptionOpen} onOpenChange={setCreateOptionOpen} />
      <EditOptionDialog
        groupId={groupId}
        option={editingOption}
        open={editingOption !== null}
        onOpenChange={(next) => {
          if (!next) setEditingOption(null);
        }}
      />
      <ManageOptionDeductionDialog
        groupId={groupId}
        option={deductionOption}
        open={deductionOption !== null}
        onOpenChange={(next) => {
          if (!next) setDeductionOption(null);
        }}
      />
    </div>
  );
}
