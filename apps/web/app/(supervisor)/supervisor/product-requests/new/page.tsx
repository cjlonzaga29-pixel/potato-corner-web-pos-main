'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import type { ProposedFlavor, ProposedRecipe, ProposedVariant } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranchStore } from '@/stores/branch.store';
import { useIngredients } from '@/hooks/queries/use-inventory';
import { useFlavors } from '@/hooks/queries/use-flavors';
import { useSubmitProductRequest } from '@/hooks/queries/use-product-requests';

const STEPS = ['Product Info', 'Variants', 'Flavors', 'Recipes', 'Reason'] as const;

export default function NewProductRequestPage() {
  const router = useRouter();
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const submit = useSubmitProductRequest();
  const { data: ingredients } = useIngredients(activeBranchId);
  const { data: flavorData } = useFlavors({ isActive: true, limit: 100 });

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [variants, setVariants] = useState<ProposedVariant[]>([{ name: '', size_label: '', base_price: 0 }]);
  const [flavors, setFlavors] = useState<ProposedFlavor[]>([]);
  const [recipes, setRecipes] = useState<ProposedRecipe[]>([]);
  const [reason, setReason] = useState('');

  if (!activeBranchId) {
    return <p className="text-sm text-destructive">Select an active branch before submitting a product request.</p>;
  }

  function addVariant() {
    setVariants((prev) => [...prev, { name: '', size_label: '', base_price: 0 }]);
  }
  function updateVariant(index: number, patch: Partial<ProposedVariant>) {
    setVariants((prev) => prev.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  }
  function removeVariant(index: number) {
    setVariants((prev) => prev.filter((_, i) => i !== index));
    setRecipes((prev) => prev.filter((r) => r.variant_index !== index));
  }

  function addFlavor() {
    setFlavors((prev) => [...prev, { name: '', color_hex: '#CCCCCC', price_premium: 0 }]);
  }
  function updateFlavor(index: number, patch: Partial<ProposedFlavor>) {
    setFlavors((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }
  function removeFlavor(index: number) {
    setFlavors((prev) => prev.filter((_, i) => i !== index));
  }

  function addRecipe() {
    setRecipes((prev) => [...prev, { variant_index: 0, ingredient_id: '', flavor_id: null, quantity: 0, unit: '' }]);
  }
  function updateRecipe(index: number, patch: Partial<ProposedRecipe>) {
    setRecipes((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function removeRecipe(index: number) {
    setRecipes((prev) => prev.filter((_, i) => i !== index));
  }

  const canProceed =
    step === 0
      ? name.trim().length >= 2
      : step === 1
        ? variants.length > 0 && variants.every((v) => v.name && v.size_label && v.base_price > 0)
        : step === 4
          ? reason.trim().length >= 30
          : true;

  async function handleSubmit() {
    if (!activeBranchId) return;
    await submit.mutateAsync({
      branch_id: activeBranchId,
      proposed_name: name,
      proposed_description: description || undefined,
      proposed_category: category || undefined,
      proposed_variants: variants,
      proposed_flavors: flavors,
      proposed_recipes: recipes,
      request_reason: reason,
    });
    router.push('/supervisor/product-requests');
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Submit New Product Request</h1>
        <p className="text-sm text-muted-foreground">Proposes a new product for Super Admin approval. Approved products are branch-exclusive to you until expanded.</p>
      </div>

      <div className="flex items-center gap-2 text-sm">
        {STEPS.map((label, index) => (
          <div key={label} className={`flex-1 border-b-2 pb-2 text-center ${index === step ? 'border-primary font-medium' : 'border-muted text-muted-foreground'}`}>
            {index + 1}. {label}
          </div>
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-4">
          <div className="space-y-1">
            <Label>Product Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cheese Fries" />
          </div>
          <div className="space-y-1">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </div>
          <div className="space-y-1">
            <Label>Category</Label>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Fries" />
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          {variants.map((variant, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input placeholder="Name" value={variant.name} onChange={(e) => updateVariant(index, { name: e.target.value })} />
              <Input placeholder="Size" value={variant.size_label} onChange={(e) => updateVariant(index, { size_label: e.target.value })} />
              <Input
                type="number"
                placeholder="Price"
                className="w-28"
                value={variant.base_price || ''}
                onChange={(e) => updateVariant(index, { base_price: Number(e.target.value) })}
              />
              <Button type="button" variant="ghost" size="icon" onClick={() => removeVariant(index)} disabled={variants.length === 1}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addVariant}>
            <Plus className="mr-2 h-4 w-4" />
            Add Variant
          </Button>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Optional. Proposed new flavors — Super Admin can approve as-is or link existing flavors instead.</p>
          {flavors.map((flavor, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input placeholder="Flavor name" value={flavor.name ?? ''} onChange={(e) => updateFlavor(index, { name: e.target.value })} />
              <Input
                type="color"
                className="w-16 p-1"
                value={flavor.color_hex ?? '#CCCCCC'}
                onChange={(e) => updateFlavor(index, { color_hex: e.target.value })}
              />
              <Input
                type="number"
                placeholder="Price premium"
                className="w-32"
                value={flavor.price_premium || ''}
                onChange={(e) => updateFlavor(index, { price_premium: Number(e.target.value) })}
              />
              <Button type="button" variant="ghost" size="icon" onClick={() => removeFlavor(index)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addFlavor}>
            <Plus className="mr-2 h-4 w-4" />
            Add Flavor
          </Button>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Optional. Recipes reference an existing branch ingredient and one of the variants above. Leave flavor unset for a base
            ingredient row.
          </p>
          {recipes.map((recipe, index) => (
            <div key={index} className="flex items-center gap-2">
              <Select value={String(recipe.variant_index)} onValueChange={(v) => updateRecipe(index, { variant_index: Number(v) })}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {variants.map((v, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {v.name || `Variant ${i + 1}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={recipe.ingredient_id} onValueChange={(v) => updateRecipe(index, { ingredient_id: v })}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Ingredient" />
                </SelectTrigger>
                <SelectContent>
                  {ingredients?.map((ing) => (
                    <SelectItem key={ing.id} value={ing.id}>
                      {ing.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={recipe.flavor_id ?? 'none'}
                onValueChange={(v) => updateRecipe(index, { flavor_id: v === 'none' ? null : v })}
              >
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Flavor (base)" />
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
              <Input
                type="number"
                placeholder="Qty"
                className="w-20"
                value={recipe.quantity || ''}
                onChange={(e) => updateRecipe(index, { quantity: Number(e.target.value) })}
              />
              <Input placeholder="Unit" className="w-20" value={recipe.unit} onChange={(e) => updateRecipe(index, { unit: e.target.value })} />
              <Button type="button" variant="ghost" size="icon" onClick={() => removeRecipe(index)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addRecipe} disabled={!ingredients?.length}>
            <Plus className="mr-2 h-4 w-4" />
            Add Recipe Row
          </Button>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-1">
          <Label>Reason for this request (minimum 30 characters)</Label>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} />
          {reason.trim().length > 0 && reason.trim().length < 30 && (
            <p className="text-xs text-destructive">{30 - reason.trim().length} more characters needed.</p>
          )}
        </div>
      )}

      <div className="flex justify-between">
        <Button type="button" variant="outline" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
          Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button type="button" onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))} disabled={!canProceed}>
            Next
          </Button>
        ) : (
          <Button type="button" onClick={() => void handleSubmit()} disabled={!canProceed || submit.isPending}>
            {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit Request
          </Button>
        )}
      </div>
    </div>
  );
}
