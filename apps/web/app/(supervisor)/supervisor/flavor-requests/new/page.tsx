'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FlavorColorSwatch } from '@/components/admin/flavors/flavor-color-swatch';
import { useBranchStore } from '@/stores/branch.store';
import { useSubmitFlavorRequest } from '@/hooks/queries/use-flavor-requests';

const REASON_MIN_LENGTH = 30;
const DEFAULT_COLOR = '#CCCCCC';

export default function NewFlavorRequestPage() {
  const router = useRouter();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const submit = useSubmitFlavorRequest();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [colorHex, setColorHex] = useState(DEFAULT_COLOR);
  const [displayOrder, setDisplayOrder] = useState('');
  const [reason, setReason] = useState('');

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch before submitting a flavor request.</p>;
  }

  const canSubmit = name.trim().length >= 2 && /^#[0-9A-Fa-f]{6}$/.test(colorHex) && reason.trim().length >= REASON_MIN_LENGTH;

  async function handleSubmit() {
    if (!activeBranchId || !canSubmit) return;
    await submit.mutateAsync({
      branch_id: activeBranchId,
      proposed_name: name.trim(),
      proposed_description: description.trim() || undefined,
      proposed_color_hex: colorHex,
      proposed_display_order: displayOrder ? Number(displayOrder) : undefined,
      request_reason: reason.trim(),
    });
    router.push('/supervisor/flavor-requests');
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Submit New Flavor Request</h1>
        <p className="text-sm text-muted-foreground">Proposes a new flavor for Super Admin approval.</p>
      </div>

      <div className="space-y-4">
        <div className="space-y-1">
          <Label>Flavor Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cheese Explosion" maxLength={50} />
        </div>

        <div className="space-y-1">
          <Label>Description</Label>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={255} />
        </div>

        <div className="space-y-1">
          <Label>Color</Label>
          <div className="flex items-center gap-3">
            <FlavorColorSwatch colorHex={colorHex} className="h-8 w-8" />
            <Input type="color" className="h-10 w-20 p-1" value={colorHex} onChange={(e) => setColorHex(e.target.value)} />
            <Input
              value={colorHex}
              onChange={(e) => setColorHex(e.target.value)}
              placeholder="#RRGGBB"
              className="w-32"
              maxLength={7}
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label>Display Order</Label>
          <Input
            type="number"
            min={0}
            value={displayOrder}
            onChange={(e) => setDisplayOrder(e.target.value)}
            placeholder="Optional"
            className="w-32"
          />
        </div>

        <div className="space-y-1">
          <Label>Reason for this request (minimum {REASON_MIN_LENGTH} characters)</Label>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} />
          <p className="text-xs text-muted-foreground">
            {reason.trim().length}/{REASON_MIN_LENGTH} characters
            {reason.trim().length < REASON_MIN_LENGTH && ` (${REASON_MIN_LENGTH - reason.trim().length} more needed)`}
          </p>
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit || submit.isPending}>
          {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Submit Request
        </Button>
      </div>
    </div>
  );
}
