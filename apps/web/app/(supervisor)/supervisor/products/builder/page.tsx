'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, Check, Loader2, Plus, Trash2 } from 'lucide-react';
import type { ProductVariantResponse } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
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
  useProductReadiness,
  usePublishProduct,
} from '@/hooks/queries/use-products';
import {
  useVariantOptionGroups,
  useUnassignVariantOptionGroup,
} from '@/hooks/queries/use-product-options';
import { RecipeBomPanel } from '@/components/products/recipe-bom-panel';
import { VariantFormDialog } from '@/components/admin/products/variant-form-dialog';
import { LinkFlavorDialog } from '@/components/admin/products/link-flavor-dialog';
import { AssignOptionGroupDialog } from '@/components/admin/products/assign-option-group-dialog';
import { ReadinessChecklist } from '@/components/admin/products/readiness-checklist';
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
  branch_id: z.string().min(1, 'Select a branch'),
});
type DetailsFormValues = z.input<typeof detailsFormSchema>;

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
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{existingProduct?.name ?? 'Loading…'}</CardTitle>
          <CardDescription>{existingProduct?.category_name ?? 'Uncategorized'}</CardDescription>
        </CardHeader>
        <CardContent>
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

  const myActiveBranchIds = user?.branchIds ?? [];
  const myBranches = (branchData?.branches ?? []).filter((b) => myActiveBranchIds.includes(b.id));

  const form = useForm<DetailsFormValues>({
    resolver: zodResolver(detailsFormSchema),
    defaultValues: {
      name: '',
      description: '',
      category_id: '',
      branch_id: myBranches.length === 1 ? myBranches[0]!.id : '',
    },
  });
  const [pendingImage, setPendingImage] = useState<File | null>(null);
  const [createdProductId, setCreatedProductId] = useState<string | null>(null);

  // Auto-select when exactly one active branch resolves after load; otherwise leave cleared for a deliberate pick.
  useEffect(() => {
    if (myBranches.length === 1 && !form.getValues('branch_id')) {
      form.setValue('branch_id', myBranches[0]!.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myBranches.length]);

  async function onSubmit(values: DetailsFormValues) {
    let productId = createdProductId;
    if (!productId) {
      const created = await createProduct.mutateAsync({
        name: values.name,
        description: values.description || undefined,
        category_id: values.category_id || undefined,
        status: 'draft',
        is_seasonal: false,
        branch_exclusive: true,
        exclusive_branch_id: values.branch_id,
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
        description="You need an active assignment to at least one branch before you can build a product. Ask an admin to assign you to a branch."
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

            <div className="space-y-2">
              <Label htmlFor="builder-branch">Branch</Label>
              {myBranches.length === 1 ? (
                <p className="bg-muted/30 rounded-md border px-3 py-2 text-sm font-medium">
                  {myBranches[0]!.name} ({myBranches[0]!.code})
                </p>
              ) : (
                <Select
                  value={form.watch('branch_id')}
                  onValueChange={(value) => form.setValue('branch_id', value)}
                  disabled={branchesLoading}
                >
                  <SelectTrigger id="builder-branch">
                    <SelectValue placeholder="Select a branch" />
                  </SelectTrigger>
                  <SelectContent>
                    {myBranches.map((branch) => (
                      <SelectItem key={branch.id} value={branch.id}>
                        {branch.name} ({branch.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-muted-foreground text-xs">
                This product publishes only to this branch.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Photo</Label>
              <ImageUpload
                label="Product Image"
                description="Optional — JPEG, PNG, or WebP, up to 5MB."
                onImageSelected={setPendingImage}
              />
            </div>

            <Button type="submit" disabled={isSubmitting}>
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

  const branchId = product.exclusive_branch_id;
  const variants = [...product.variants].sort(
    (a, b) => (a.display_order ?? 0) - (b.display_order ?? 0),
  );

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Configure what each size consumes per serving — inventory item, quantity, and unit. Create a
        new inventory item inline if you don&apos;t see it in the list.
      </p>
      {variants.map((variant) => (
        <RecipeBomPanel
          key={variant.id}
          productVariantId={variant.id}
          variantLabel={`${variant.name} (${variant.size_label})`}
          branchId={branchId}
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
  );
}

// --- Step 5: Review ---

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
  const branchId = product?.exclusive_branch_id ?? null;
  const readiness = useProductReadiness(productId, branchId);
  const publishProduct = usePublishProduct(productId);
  const { reset } = useProductBuilderStore();
  const router = useRouter();

  if (isLoading || !product) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  const isPublished = branchId
    ? product.branch_availability.some((row) => row.branch_id === branchId && row.is_available)
    : false;

  async function handlePublish() {
    if (!branchId) return;
    await publishProduct.mutateAsync(branchId);
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

      {readiness.isLoading ? (
        <div className="flex justify-center py-8">
          <LoadingSpinner />
        </div>
      ) : readiness.data && readiness.data.scope === 'branch' ? (
        <ReadinessChecklist
          data={readiness.data}
          onNavigateToTab={(tab) => onJumpToStep(tab === 'variants' ? 'ingredients' : 'sizes')}
        />
      ) : null}

      <div className="flex flex-wrap justify-between gap-3 pt-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleSaveDraft}>
            Save Draft
          </Button>
          <Button
            onClick={() => void handlePublish()}
            disabled={
              isPublished ||
              !readiness.data ||
              readiness.data.scope !== 'branch' ||
              !readiness.data.sellable ||
              publishProduct.isPending
            }
          >
            {publishProduct.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isPublished ? 'Already on POS' : 'Add to POS'}
          </Button>
        </div>
      </div>
    </div>
  );
}
