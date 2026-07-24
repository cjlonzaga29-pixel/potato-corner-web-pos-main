'use client';

import { useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useBranchStore } from '@/stores/branch.store';
import { useProducts, useProduct } from '@/hooks/queries/use-products';
import { useIngredients } from '@/hooks/queries/use-inventory';
import { useFlavors } from '@/hooks/queries/use-flavors';
import {
  useMasterRecipes,
  useRecipeOverrides,
  useCreateRecipeOverride,
  useDeleteRecipeOverride,
  useSimulateDeduction,
} from '@/hooks/queries/use-recipe-overrides';

/** Shared body behind both `/supervisor/recipes` and `/branch/recipes`. */
export function RecipeOverridesView() {
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const { data: productData } = useProducts({ status: 'active', limit: 100 });
  const [productId, setProductId] = useState('');
  const { data: product } = useProduct(productId || undefined);
  const [variantId, setVariantId] = useState('');
  const [flavorFilter, setFlavorFilter] = useState<string>('none');

  const { data: ingredients } = useIngredients(activeBranchId);
  const { data: flavorData } = useFlavors({ isActive: true, limit: 100 });
  const { data: masterRecipes } = useMasterRecipes(variantId || undefined);
  const { data: overrides } = useRecipeOverrides(variantId || undefined, activeBranchId);
  const createOverride = useCreateRecipeOverride(variantId);
  const deleteOverride = useDeleteRecipeOverride(variantId, activeBranchId ?? '');
  const simulate = useSimulateDeduction();

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [ingredientId, setIngredientId] = useState('');
  const [overrideFlavor, setOverrideFlavor] = useState('none');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [reason, setReason] = useState('');

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch to manage recipe overrides.</p>;
  }

  async function handleCreate() {
    if (!activeBranchId) return;
    await createOverride.mutateAsync({
      branch_id: activeBranchId,
      ingredient_id: ingredientId,
      flavor_id: overrideFlavor === 'none' ? null : overrideFlavor,
      quantity: Number(quantity),
      unit,
      reason,
    });
    setCreateOpen(false);
    setIngredientId('');
    setOverrideFlavor('none');
    setQuantity('');
    setUnit('');
    setReason('');
  }

  async function handleSimulate() {
    if (!variantId) return;
    await simulate.mutateAsync({
      product_variant_id: variantId,
      flavor_id: flavorFilter === 'none' ? undefined : flavorFilter,
      quantity_sold: 1,
      branch_id: activeBranchId ?? undefined,
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Recipe Overrides</h1>
        <p className="text-sm text-muted-foreground">Override master recipe ingredients for your branch. No approval needed — every change is audit-logged.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Select
          value={productId}
          onValueChange={(value) => {
            setProductId(value);
            setVariantId('');
          }}
        >
          <SelectTrigger className="w-56">
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

        {product && (
          <Select value={variantId} onValueChange={setVariantId}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Select a variant" />
            </SelectTrigger>
            <SelectContent>
              {product.variants.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name} ({v.size_label})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {variantId && (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-2 rounded-md border p-3">
              <p className="font-medium">Master Recipe</p>
              {masterRecipes && masterRecipes.length > 0 ? (
                <ul className="space-y-1 text-sm">
                  {masterRecipes.map((r) => (
                    <li key={r.id}>
                      {r.ingredient_name} — {r.quantity} {r.unit} {r.flavor_name ? `(${r.flavor_name})` : '(base)'}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No master recipe rows defined for this variant.</p>
              )}
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <p className="font-medium">Your Branch Overrides</p>
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Override
                </Button>
              </div>
              {overrides && overrides.length > 0 ? (
                <ul className="space-y-1 text-sm">
                  {overrides.map((o) => (
                    <li key={o.id} className="flex items-center justify-between">
                      <span>
                        {o.ingredient_name} — {o.quantity} {o.unit} {o.flavor_name ? `(${o.flavor_name})` : '(base)'}
                      </span>
                      <Button variant="ghost" size="icon" onClick={() => setDeleteTargetId(o.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No overrides yet — deduction uses the master recipe as-is.</p>
              )}
            </div>
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <p className="font-medium">Simulate Deduction</p>
              <Select value={flavorFilter} onValueChange={setFlavorFilter}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No flavor</SelectItem>
                  {flavorData?.flavors.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" onClick={() => void handleSimulate()} disabled={simulate.isPending}>
                {simulate.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Run (branch overrides applied)
              </Button>
            </div>
            {simulate.data && (
              <ul className="space-y-1 text-sm">
                {simulate.data.lines.map((line) => (
                  <li key={line.ingredient_id}>
                    {line.ingredient_name}: {line.quantity} {line.unit}{' '}
                    <span className="text-xs text-muted-foreground">({line.source})</span>
                  </li>
                ))}
                {simulate.data.lines.length === 0 && <EmptyState title="No ingredients" description="Nothing would be deducted." />}
              </ul>
            )}
          </div>
        </>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Branch Recipe Override</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Ingredient</Label>
              <Select value={ingredientId} onValueChange={setIngredientId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select ingredient" />
                </SelectTrigger>
                <SelectContent>
                  {ingredients?.map((ing) => (
                    <SelectItem key={ing.id} value={ing.id}>
                      {ing.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Flavor (leave as base for no flavor)</Label>
              <Select value={overrideFlavor} onValueChange={setOverrideFlavor}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Base (no flavor)</SelectItem>
                  {flavorData?.flavors.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Quantity</Label>
                <Input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Unit</Label>
                <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="g, ml, pcs" />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Reason (minimum 20 characters)</Label>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={!ingredientId || !quantity || !unit || reason.trim().length < 20 || createOverride.isPending}
            >
              {createOverride.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Override
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTargetId}
        onOpenChange={(o) => !o && setDeleteTargetId(null)}
        title="Delete Recipe Override"
        description="This removes the branch-specific override and reverts to the base recipe."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (!deleteTargetId) return;
          await deleteOverride.mutateAsync(deleteTargetId);
        }}
      />
    </div>
  );
}
