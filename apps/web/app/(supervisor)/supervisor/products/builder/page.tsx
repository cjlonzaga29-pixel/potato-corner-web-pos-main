'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertTriangle, ArrowLeft, Check, Loader2, Plus, Trash2 } from 'lucide-react';
import type { ProductDetailResponse, ProductVariantResponse, PublicationCheckResponse, PublicationIssue } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ImageUpload } from '@/components/shared/forms/image-upload';
import { useAuth } from '@/hooks/use-auth';
import { useBranches } from '@/hooks/queries/use-branches';
import { useProductCategories } from '@/hooks/queries/use-product-categories';
import {
  useProduct,
  useCreateProduct,
  useUploadProductImage,
  useDeleteVariant,
  usePublicationCheck,
  usePublishProductToBranches,
} from '@/hooks/queries/use-products';
import {
  useVariantOptionGroups,
  useUnassignVariantOptionGroup,
} from '@/hooks/queries/use-product-options';
import { RecipeBomPanel } from '@/components/products/recipe-bom-panel';
import { ProductWriteError } from '@/components/products/product-write-error';
import { FlavorSlotPanel } from '@/components/admin/products/flavor-slot-panel';
import { VariantFormDialog } from '@/components/admin/products/variant-form-dialog';
import { LinkFlavorDialog } from '@/components/admin/products/link-flavor-dialog';
import { AssignOptionGroupDialog } from '@/components/admin/products/assign-option-group-dialog';
import {
  BUILDER_STEPS,
  useProductBuilderStore,
  type BuilderStep,
} from '@/stores/product-builder.store';

const STEP_LABELS: Record<BuilderStep, string> = {
  details: 'Product Details',
  sizes: 'Sizes & Prices',
  ingredients: 'Ingredients & Packaging',
  choices: 'Choices',
  review: 'Review',
};

function BuilderPageInner() {
  const searchParams = useSearchParams();
  const editProductId = searchParams.get('product_id');
  const { productId, step, setStep, setProductId, reset, loadExisting } = useProductBuilderStore();

  // Entering with ?product_id= (Edit Product) always takes over the draft,
  // even if a different unrelated draft was in progress — editing an
  // existing product is a distinct entry point from resuming a new one.
  useEffect(() => {
    if (editProductId && editProductId !== productId) {
      loadExisting(editProductId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editProductId]);

  const stepIndex = BUILDER_STEPS.indexOf(step);

  function goToStep(target: BuilderStep) {
    setStep(target);
  }

  function goNext() {
    const next = BUILDER_STEPS[stepIndex + 1];
    if (next) setStep(next);
  }

  function goBack() {
    const prev = BUILDER_STEPS[stepIndex - 1];
    if (prev) setStep(prev);
  }

  return (
    <div className="app-section app-section-gap">
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" asChild className="-ml-2 self-start">
          <Link href="/supervisor/products">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to products
          </Link>
        </Button>
        {productId && (
          <Button variant="ghost" size="sm" onClick={() => reset()}>
            Start a new product
          </Button>
        )}
      </div>

      <div>
        <h1 className="app-title font-bold">{productId ? 'Edit Product' : 'New Product'}</h1>
        <p className="text-muted-foreground text-sm">
          Build one sellable product step by step — details, sizes, ingredients, choices, then
          publish.
        </p>
      </div>

      <StepIndicator current={step} onSelect={productId ? goToStep : undefined} />

      {step === 'details' && (
        <DetailsStep
          onCreated={(id) => {
            setProductId(id);
            goNext();
          }}
          onContinue={goNext}
        />
      )}
      {step === 'sizes' && productId && (
        <SizesStep productId={productId} onBack={goBack} onNext={goNext} />
      )}
      {step === 'ingredients' && productId && (
        <IngredientsStep productId={productId} onBack={goBack} onNext={goNext} />
      )}
      {step === 'choices' && productId && (
        <ChoicesStep productId={productId} onBack={goBack} onNext={goNext} />
      )}
      {step === 'review' && productId && (
        <ReviewStep productId={productId} onBack={goBack} onJumpToStep={goToStep} />
      )}
    </div>
  );
}

export default function ProductBuilderPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      }
    >
      <BuilderPageInner />
    </Suspense>
  );
}

function StepIndicator({
  current,
  onSelect,
}: {
  current: BuilderStep;
  onSelect?: (step: BuilderStep) => void;
}) {
  const currentIndex = BUILDER_STEPS.indexOf(current);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {BUILDER_STEPS.map((step, index) => {
        const isDone = index < currentIndex;
        const isCurrent = step === current;
        const clickable = Boolean(onSelect) && index <= currentIndex;
        return (
          <button
            key={step}
            type="button"
            disabled={!clickable}
            onClick={() => clickable && onSelect?.(step)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              isCurrent
                ? 'border-primary bg-primary text-primary-foreground'
                : isDone
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
                  : 'border-muted-foreground/30 text-muted-foreground'
            } ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
          >
            {isDone && <Check className="h-3 w-3" />}
            {index + 1}. {STEP_LABELS[step]}
          </button>
        );
      })}
    </div>
  );
}

// --- Step 1: Product Details ---

const detailsFormSchema = z.object({
  name: z.string().min(2, 'Minimum 2 characters').max(100),
  description: z.string().max(500).optional(),
  category_id: z.string().optional(),
  branch_ids: z.array(z.string()).min(1, 'Select at least one branch'),
});
type DetailsFormValues = z.input<typeof detailsFormSchema>;

interface BuilderBranch {
  id: string;
  name: string;
}

/**
 * POS-PERF-P37 — the branches this builder product publishes to, as the
 * server records them: a branch-exclusive product's one branch, or a
 * multi-branch selection's branch_availability rows. A legacy shared product
 * (neither) has no builder selection — it's published per branch from its
 * product page, exactly as before.
 */
function builderBranches(product: ProductDetailResponse): BuilderBranch[] {
  if (product.branch_exclusive && product.exclusive_branch_id) {
    const row = product.branch_availability.find((r) => r.branch_id === product.exclusive_branch_id);
    return [{ id: product.exclusive_branch_id, name: product.exclusive_branch_name ?? row?.branch_name ?? 'Branch' }];
  }
  if (product.branch_selection_scoped) {
    return [...product.branch_availability]
      .sort((a, b) => a.branch_name.localeCompare(b.branch_name))
      .map((row) => ({ id: row.branch_id, name: row.branch_name }));
  }
  return [];
}

function DetailsStep({
  onCreated,
  onContinue,
}: {
  onCreated: (productId: string) => void;
  onContinue: () => void;
}) {
  const { productId } = useProductBuilderStore();
  const { data: existingProduct } = useProduct(productId);

  if (productId) {
    // Resuming/editing an existing product — Step 1's one-time fields are
    // already set; this step is just a summary with a way forward. Name/
    // category/image live on the existing Edit Product flow, not duplicated
    // here, so builder-driven edits never fight with it over the same field.
    const branches = existingProduct ? builderBranches(existingProduct) : [];
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{existingProduct?.name ?? 'Loading…'}</CardTitle>
          <CardDescription>{existingProduct?.category_name ?? 'Uncategorized'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {branches.length > 0 && (
            <p className="text-sm" data-testid="builder-selected-branches">
              <span className="text-muted-foreground">Available at: </span>
              {branches.map((b) => b.name).join(', ')}
            </p>
          )}
          <Button onClick={onContinue}>Continue to Sizes &amp; Prices</Button>
        </CardContent>
      </Card>
    );
  }

  return <NewProductDetailsForm onCreated={onCreated} />;
}

function NewProductDetailsForm({ onCreated }: { onCreated: (productId: string) => void }) {
  const { user } = useAuth();
  const createProduct = useCreateProduct();
  const uploadImage = useUploadProductImage();
  const { data: categoryData, isLoading: categoriesLoading } = useProductCategories({
    isActive: true,
    limit: 100,
  });
  const { data: branchData, isLoading: branchesLoading } = useBranches({
    status: 'active',
    limit: 100,
  });

  const { draftBranchIds, setDraftBranchIds } = useProductBuilderStore();

  // "Assigned branches" = active branches this supervisor is assigned to
  // right now — never every branch in the organization. The server re-checks
  // the live assignment on create and again on Add to POS.
  const myActiveBranchIds = user?.branchIds ?? [];
  const myBranches = (branchData?.branches ?? [])
    .filter((b) => myActiveBranchIds.includes(b.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const myBranchIdsKey = myBranches.map((b) => b.id).join(',');

  const form = useForm<DetailsFormValues>({
    resolver: zodResolver(detailsFormSchema),
    defaultValues: {
      name: '',
      description: '',
      category_id: '',
      branch_ids: [],
    },
  });
  const [pendingImage, setPendingImage] = useState<File | null>(null);
  const [createdProductId, setCreatedProductId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const selectedBranchIds = form.watch('branch_ids');

  // Once assigned branches resolve: restore a persisted draft selection
  // (dropping any branch no longer assigned), or preselect the only branch.
  useEffect(() => {
    if (branchesLoading) return;
    const assigned = new Set(myBranches.map((b) => b.id));
    const restored = draftBranchIds.filter((id) => assigned.has(id));
    const initial = restored.length > 0 ? restored : myBranches.length === 1 ? [myBranches[0]?.id ?? ''] : [];
    form.setValue('branch_ids', initial.filter(Boolean));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchesLoading, myBranchIdsKey]);

  function setSelectedBranchIds(branchIds: string[]) {
    form.setValue('branch_ids', branchIds, { shouldValidate: form.formState.isSubmitted });
    setDraftBranchIds(branchIds);
  }

  function toggleBranch(branchId: string, checked: boolean) {
    const current = form.getValues('branch_ids');
    setSelectedBranchIds(checked ? [...new Set([...current, branchId])] : current.filter((id) => id !== branchId));
  }

  const allSelected = myBranches.length > 0 && myBranches.every((b) => selectedBranchIds.includes(b.id));
  const selectedBranchNames = myBranches.filter((b) => selectedBranchIds.includes(b.id)).map((b) => b.name);

  async function onSubmit(values: DetailsFormValues) {
    setSubmitError(null);
    try {
      await createAndContinue(values);
    } catch (error) {
      // The form, branch selection and any created product id stay as they are.
      setSubmitError(error instanceof Error ? error : new Error('Failed to save this product.'));
    }
  }

  async function createAndContinue(values: DetailsFormValues) {
    let productId = createdProductId;
    if (!productId) {
      // POS-PERF-P36R — Product.status must be 'active', not 'draft':
      // productReadinessService's PRODUCT_INACTIVE check is an unconditional
      // publish blocker (products.service.ts's publishProduct never excludes
      // it from gatingBlockers), and the builder has no later step that ever
      // changes it. A product created as 'draft' here could never reach
      // "Add to POS" — confirmed by actually driving this wizard in a real
      // browser (found during POS-PERF-P36R verification). "Not yet live" is
      // already fully represented by BranchProductAvailability.isAvailable
      // staying false until Review's "Add to POS" — that's the actual draft
      // state, not this column.
      const created = await createProduct.mutateAsync({
        name: values.name,
        description: values.description || undefined,
        category_id: values.category_id || undefined,
        status: 'active',
        is_seasonal: false,
        branch_exclusive: false,
        branch_ids: values.branch_ids,
      });
      productId = created.id;
      setCreatedProductId(created.id);
    }
    if (pendingImage) {
      await uploadImage.mutateAsync({ productId, file: pendingImage });
    }
    onCreated(productId);
  }

  const isSubmitting = createProduct.isPending || uploadImage.isPending;

  if (!branchesLoading && myBranches.length === 0) {
    return (
      <EmptyState
        title="No active branch assignment"
        description="You need an active assignment to at least one branch before you can build a product. An administrator must assign you to a branch first."
      />
    );
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormFieldWrapper<DetailsFormValues> name="name" label="Product Name" required>
              <Input placeholder="Cheese Fries" />
            </FormFieldWrapper>

            <FormFieldWrapper<DetailsFormValues> name="description" label="Description">
              <Textarea placeholder="Optional description" rows={3} />
            </FormFieldWrapper>

            <div className="space-y-2">
              <Label htmlFor="builder-category">Category</Label>
              <Select
                value={form.watch('category_id')}
                onValueChange={(value) => form.setValue('category_id', value)}
                disabled={categoriesLoading}
              >
                <SelectTrigger id="builder-category">
                  <SelectValue placeholder={categoriesLoading ? 'Loading…' : 'Select a category'} />
                </SelectTrigger>
                <SelectContent>
                  {(categoryData?.categories ?? []).map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <fieldset className="space-y-2" aria-describedby="builder-branches-summary">
              <legend className="text-sm font-medium leading-none">Available at branches</legend>
              {branchesLoading ? (
                <p className="text-muted-foreground text-sm">Loading your branches…</p>
              ) : (
                <div className="space-y-2 rounded-md border p-3">
                  {myBranches.length > 1 && (
                    <label className="flex items-center gap-2 border-b pb-2 text-sm font-medium">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={(checked) =>
                          setSelectedBranchIds(checked === true ? myBranches.map((b) => b.id) : [])
                        }
                        aria-label="Select all assigned branches"
                      />
                      Select all assigned branches
                    </label>
                  )}
                  {myBranches.map((branch) => (
                    <label key={branch.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={selectedBranchIds.includes(branch.id)}
                        onCheckedChange={(checked) => toggleBranch(branch.id, checked === true)}
                        aria-label={branch.name}
                      />
                      {branch.name} ({branch.code})
                    </label>
                  ))}
                </div>
              )}
              <p id="builder-branches-summary" className="text-muted-foreground text-xs" data-testid="builder-branch-count">
                {selectedBranchNames.length === 0
                  ? 'Select at least one branch. The product is only added to the POS at the branches you select.'
                  : `${selectedBranchNames.length} branch${selectedBranchNames.length === 1 ? '' : 'es'} selected: ${selectedBranchNames.join(', ')}. You configure the product once; Add to POS publishes it at these branches only.`}
              </p>
              {form.formState.errors.branch_ids && (
                <p className="text-destructive text-sm font-medium" role="alert">
                  {form.formState.errors.branch_ids.message}
                </p>
              )}
            </fieldset>

            <div className="space-y-2">
              <Label>Photo</Label>
              <ImageUpload
                label="Product Image"
                description="Optional — JPEG, PNG, or WebP, up to 5MB."
                onImageSelected={setPendingImage}
              />
            </div>

            {submitError && (
              <ProductWriteError error={submitError} failedTitle="Couldn't save this product" pausedTitle="Saving is paused for maintenance" testId="builder-write-error" />
            )}

            <Button type="submit" disabled={isSubmitting || branchesLoading || selectedBranchIds.length === 0}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Continue to Sizes &amp; Prices
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

// --- Step 2: Sizes & Prices ---

function SizesStep({
  productId,
  onBack,
  onNext,
}: {
  productId: string;
  onBack: () => void;
  onNext: () => void;
}) {
  const { data: product, isLoading } = useProduct(productId);
  const deleteVariant = useDeleteVariant(productId);
  const [variantDialog, setVariantDialog] = useState<{
    open: boolean;
    variant?: ProductVariantResponse;
  }>({ open: false });

  if (isLoading || !product) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  const variants = [...product.variants].sort(
    (a, b) => (a.display_order ?? 0) - (b.display_order ?? 0),
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Sizes &amp; Prices</CardTitle>
          <CardDescription>Add every size this product is sold in, with its price.</CardDescription>
        </div>
        <Button size="sm" onClick={() => setVariantDialog({ open: true })}>
          <Plus className="mr-2 h-4 w-4" />
          Add Size
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {variants.length === 0 ? (
          <EmptyState
            title="No sizes yet"
            description="Add at least one size and price to continue."
          />
        ) : (
          variants.map((variant) => (
            <div
              key={variant.id}
              className="flex items-center justify-between gap-3 rounded-md border p-3"
            >
              <div>
                <p className="font-medium">
                  {variant.name} — {variant.size_label}
                </p>
                <p className="text-muted-foreground text-sm">₱{variant.base_price.toFixed(2)}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setVariantDialog({ open: true, variant })}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => void deleteVariant.mutateAsync(variant.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))
        )}

        <div className="flex justify-between pt-2">
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
          <Button onClick={onNext} disabled={variants.length === 0}>
            Continue to Ingredients &amp; Packaging
          </Button>
        </div>
      </CardContent>

      <VariantFormDialog
        open={variantDialog.open}
        onOpenChange={(open) => setVariantDialog((prev) => ({ ...prev, open }))}
        productId={productId}
        variant={variantDialog.variant}
      />
    </Card>
  );
}

// --- Step 3: Ingredients & Packaging ---

function IngredientsStep({
  productId,
  onBack,
  onNext,
}: {
  productId: string;
  onBack: () => void;
  onNext: () => void;
}) {
  const { data: product, isLoading } = useProduct(productId);

  if (isLoading || !product) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  // POS-PERF-P38 — no per-branch inventory badge here: before Add to POS a
  // selected branch may not stock an item yet, which Add to POS sets up
  // itself, so that badge would report setup the supervisor doesn't have to
  // do. Review shows each branch's real status.
  const branches = builderBranches(product);
  const variants = [...product.variants].sort(
    (a, b) => (a.display_order ?? 0) - (b.display_order ?? 0),
  );

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Configure what each size consumes per serving — inventory item, quantity, and unit. Create a
        new inventory item inline if you don&apos;t see it in the list.
      </p>
      {branches.length > 1 && (
        <p className="text-muted-foreground text-sm">
          This recipe is shared by {branches.map((b) => b.name).join(', ')}. Each branch deducts its
          own stock. If a selected branch doesn&apos;t stock one of these items yet, Add to POS adds it
          to that branch&apos;s inventory at zero stock.
        </p>
      )}
      {variants.map((variant) => (
        <RecipeBomPanel
          key={variant.id}
          productVariantId={variant.id}
          variantLabel={`${variant.name} (${variant.size_label})`}
        />
      ))}
      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext}>Continue to Choices</Button>
      </div>
    </div>
  );
}

// --- Step 4: Choices ---

function ChoicesStep({
  productId,
  onBack,
  onNext,
}: {
  productId: string;
  onBack: () => void;
  onNext: () => void;
}) {
  const { data: product, isLoading } = useProduct(productId);

  if (isLoading || !product) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  const variants = [...product.variants].sort(
    (a, b) => (a.display_order ?? 0) - (b.display_order ?? 0),
  );

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Assign required/optional flavors and add-ons per size. Selection limits, pricing, and
        ingredient consumption are configured on the assigned option group itself.
      </p>
      {variants.map((variant) => (
        <ChoicesForVariant key={variant.id} productId={productId} variant={variant} />
      ))}
      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext}>Continue to Review</Button>
      </div>
    </div>
  );
}

function ChoicesForVariant({
  productId,
  variant,
}: {
  productId: string;
  variant: ProductVariantResponse;
}) {
  const { data: assignedGroups } = useVariantOptionGroups(productId, variant.id);
  const unassign = useUnassignVariantOptionGroup(productId, variant.id);
  const [assignOpen, setAssignOpen] = useState(false);
  const [linkFlavorOpen, setLinkFlavorOpen] = useState(false);

  return (
    <div className="space-y-3">
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">
            {variant.name} ({variant.size_label})
          </CardTitle>
          <CardDescription>Flavors and option groups available for this size.</CardDescription>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setLinkFlavorOpen(true)}>
            Link Flavor
          </Button>
          <Button size="sm" onClick={() => setAssignOpen(true)}>
            Assign Option Group
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {variant.flavors.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {variant.flavors.map((flavor) => (
              <Badge key={flavor.flavor_id} variant="outline">
                {flavor.name}
              </Badge>
            ))}
          </div>
        )}
        {(assignedGroups ?? []).length === 0 && variant.flavors.length === 0 ? (
          <EmptyState
            title="No choices configured"
            description="Optional — skip if this size has no flavors or add-ons."
          />
        ) : (
          <div className="space-y-2">
            {(assignedGroups ?? []).map((group) => (
              <div
                key={group.id}
                className="flex items-center justify-between rounded-md border p-2.5 text-sm"
              >
                <div>
                  <p className="font-medium">{group.name}</p>
                  <p className="text-muted-foreground text-xs">
                    {group.required ? 'Required' : 'Optional'} ·{' '}
                    {group.selection_type === 'SINGLE' ? 'Pick one' : 'Pick multiple'}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void unassign.mutateAsync(group.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <AssignOptionGroupDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        productId={productId}
        variantId={variant.id}
        assignedGroupIds={(assignedGroups ?? []).map((g) => g.option_group_id)}
      />
      <LinkFlavorDialog
        open={linkFlavorOpen}
        onOpenChange={setLinkFlavorOpen}
        productId={productId}
        variantId={variant.id}
        linkedFlavorIds={variant.flavors.map((f) => f.flavor_id)}
      />
    </Card>

    <FlavorSlotPanel
      productId={productId}
      variantId={variant.id}
      variantLabel={`${variant.name} (${variant.size_label})`}
      lifecycleStatus={variant.lifecycle_status}
    />
    </div>
  );
}

// --- Step 5: Review ---

const BRANCH_STATUS_LABELS: Record<
  PublicationCheckResponse['branches'][number]['status'],
  { label: string; variant: 'active' | 'pending' | 'warning' }
> = {
  on_pos: { label: 'On POS', variant: 'active' },
  ready: { label: 'Ready to add to POS', variant: 'pending' },
  missing_setup: { label: 'Missing setup', variant: 'warning' },
};

function PublicationIssueList({ issues, onFix }: { issues: PublicationIssue[]; onFix: (step: BuilderStep) => void }) {
  return (
    <ul className="space-y-2">
      {issues.map((issue) => (
        <li key={`${issue.code}-${issue.message}`} className="flex items-start justify-between gap-3 rounded-md border p-3 text-sm">
          <span>{issue.message}</span>
          {issue.fix_step && (
            <Button variant="outline" size="sm" onClick={() => issue.fix_step && onFix(issue.fix_step)}>
              Fix
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function ReviewStep({
  productId,
  onBack,
  onJumpToStep,
}: {
  productId: string;
  onBack: () => void;
  onJumpToStep: (step: BuilderStep) => void;
}) {
  const { data: product, isLoading } = useProduct(productId);
  const branches = product ? builderBranches(product) : [];
  const branchIds = branches.map((b) => b.id);
  const check = usePublicationCheck(productId, branchIds);
  const publishProduct = usePublishProductToBranches(productId);
  const [publishError, setPublishError] = useState<Error | null>(null);
  const { reset } = useProductBuilderStore();
  const router = useRouter();

  if (isLoading || !product) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  const plan = check.data;
  const isPublished = !!plan && plan.branches.length > 0 && plan.branches.every((b) => b.is_published);
  const canAddToPos = !!plan && plan.ready && !isPublished && !publishProduct.isPending;

  async function handlePublish() {
    if (branchIds.length === 0) return;
    setPublishError(null);
    try {
      await publishProduct.mutateAsync(branchIds);
    } catch (error) {
      // Keep the builder exactly as it is; the inline error explains what happened.
      setPublishError(error instanceof Error ? error : new Error('Failed to add this product to POS.'));
      return;
    }
    reset();
    router.push(`/supervisor/products/${productId}`);
  }

  function handleSaveDraft() {
    // Everything is already persisted incrementally as each step's own
    // mutation succeeds — "Save Draft" just leaves the product unpublished
    // (BranchProductAvailability stays off) and returns to the list.
    reset();
    router.push('/supervisor/products');
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{product.name}</CardTitle>
          <CardDescription>{product.variants.length} size(s) configured</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {product.variants.map((variant) => (
            <div key={variant.id} className="rounded-md border p-3 text-sm">
              <p className="font-medium">
                {variant.name} ({variant.size_label}) — ₱{variant.base_price.toFixed(2)}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Available at branches</CardTitle>
          <CardDescription>
            {branches.length === 0
              ? 'This product is not tied to a builder branch selection. Publish it per branch from its product page.'
              : `Sizes, recipe, flavors and options are set up once and shared by ${branches.length === 1 ? 'this branch' : `these ${branches.length} branches`}. Stock is tracked separately at each branch. Add to POS adds it at all of them at once, or at none if something is missing.`}
          </CardDescription>
        </CardHeader>
        {branches.length > 0 && (
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-1.5" data-testid="review-selected-branches">
              {branches.map((branch) => (
                <Badge key={branch.id} variant="outline">
                  {branch.name}
                </Badge>
              ))}
            </div>
            {check.isLoading ? (
              <div className="flex justify-center py-4">
                <LoadingSpinner />
              </div>
            ) : check.error ? (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Couldn&apos;t check this product</AlertTitle>
                <AlertDescription>{check.error.message}</AlertDescription>
              </Alert>
            ) : (
              plan && (
                <ul className="space-y-2">
                  {plan.branches.map((branchPlan) => {
                    const status = BRANCH_STATUS_LABELS[branchPlan.status];
                    return (
                      <li key={branchPlan.branch_id} className="space-y-2 rounded-md border p-3 text-sm" data-testid="review-branch-status">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">{branchPlan.branch_name}</span>
                          <Badge variant={status.variant}>{status.label}</Badge>
                        </div>
                        {!branchPlan.is_published && branchPlan.setup_items.length > 0 && (
                          <p className="text-muted-foreground text-xs">
                            Add to POS also adds {branchPlan.setup_items.length === 1 ? 'this item' : `these ${branchPlan.setup_items.length} items`} to
                            this branch&apos;s inventory at zero stock: {branchPlan.setup_items.map((item) => item.name).join(', ')}.
                          </p>
                        )}
                        {branchPlan.notices.map((notice) => (
                          <p key={notice} className="text-muted-foreground text-xs">
                            {notice}
                          </p>
                        ))}
                        {branchPlan.issues.length > 0 && <PublicationIssueList issues={branchPlan.issues} onFix={onJumpToStep} />}
                      </li>
                    );
                  })}
                </ul>
              )
            )}
          </CardContent>
        )}
      </Card>

      {plan && plan.issues.length > 0 && (
        <Card data-testid="review-missing-setup">
          <CardHeader>
            <CardTitle className="text-base">Missing setup</CardTitle>
            <CardDescription>Fix these before adding this product to POS. Everything else is saved.</CardDescription>
          </CardHeader>
          <CardContent>
            <PublicationIssueList issues={plan.issues} onFix={onJumpToStep} />
          </CardContent>
        </Card>
      )}

      {publishError && (
        <ProductWriteError
          error={publishError}
          failedTitle="Couldn't add to POS"
          pausedTitle="Add to POS is paused for maintenance"
          testId="builder-write-error"
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          {plan && !isPublished && <span className="text-muted-foreground text-sm">Not added to POS yet</span>}
          <Button variant="outline" onClick={handleSaveDraft}>
            Save Draft
          </Button>
          <Button onClick={() => void handlePublish()} disabled={!canAddToPos}>
            {publishProduct.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isPublished ? 'Already on POS' : 'Add to POS'}
          </Button>
        </div>
      </div>
    </div>
  );
}
