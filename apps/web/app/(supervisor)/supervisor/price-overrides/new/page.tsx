'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatCurrency } from '@/lib/utils';
import { useBranchStore } from '@/stores/branch.store';
import { useProducts, useProduct } from '@/hooks/queries/use-products';
import { useSubmitPriceOverride } from '@/hooks/queries/use-price-overrides';

export default function NewPriceOverridePage() {
  const router = useRouter();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const submit = useSubmitPriceOverride();

  const { data: productData } = useProducts({ status: 'active', limit: 100 });
  const [productId, setProductId] = useState('');
  const { data: product } = useProduct(productId || undefined);
  const [variantId, setVariantId] = useState('');
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('');

  const variant = product?.variants.find((v) => v.id === variantId);
  const canSubmit = Boolean(activeBranchId) && Boolean(variantId) && Number(price) > 0 && reason.trim().length >= 20;

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch before submitting a price override request.</p>;
  }

  async function handleSubmit() {
    if (!activeBranchId || !variantId) return;
    await submit.mutateAsync({
      branch_id: activeBranchId,
      product_variant_id: variantId,
      requested_price: Number(price),
      request_reason: reason,
    });
    router.push('/supervisor/price-overrides');
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Submit Price Override Request</h1>
        <p className="text-sm text-muted-foreground">Requests a branch-specific price for an existing catalog variant.</p>
      </div>

      <div className="space-y-1">
        <Label>Product</Label>
        <Select
          value={productId}
          onValueChange={(value) => {
            setProductId(value);
            setVariantId('');
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select a product" />
          </SelectTrigger>
          <SelectContent>
            {productData?.products.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {product && (
        <div className="space-y-1">
          <Label>Variant</Label>
          <Select value={variantId} onValueChange={setVariantId}>
            <SelectTrigger>
              <SelectValue placeholder="Select a variant" />
            </SelectTrigger>
            <SelectContent>
              {product.variants.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name} ({v.size_label}) — {formatCurrency(v.base_price)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {variant && (
        <p className="rounded-md border bg-muted/30 p-3 text-sm">
          Current master price: <span className="font-medium">{formatCurrency(variant.base_price)}</span>
        </p>
      )}

      <div className="space-y-1">
        <Label>New Price</Label>
        <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
      </div>

      <div className="space-y-1">
        <Label>Reason (minimum 20 characters)</Label>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} />
        {reason.trim().length > 0 && reason.trim().length < 20 && (
          <p className="text-xs text-destructive">{20 - reason.trim().length} more characters needed.</p>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit || submit.isPending}>
          {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Submit for Approval
        </Button>
      </div>
    </div>
  );
}
