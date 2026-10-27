'use client';

import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertTriangle, ImageIcon, Loader2, Trash2 } from 'lucide-react';
import type { ProductDetailResponse } from '@potato-corner/shared';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ImageUpload } from '@/components/shared/forms/image-upload';
import { useProductCategories } from '@/hooks/queries/use-product-categories';
import { ProductApiError, useDeleteProductImage, useProductImage, useUpdateProduct, useUploadProductImage } from '@/hooks/queries/use-products';

const NO_CATEGORY = '__none__';

const formSchema = z
  .object({
    name: z.string().trim().min(2, 'Minimum 2 characters').max(100),
    description: z.string().max(500),
    category_id: z.string(),
    display_order: z.string().regex(/^\d*$/, 'Use a whole number'),
    is_seasonal: z.boolean(),
    seasonal_start_date: z.string(),
    seasonal_end_date: z.string(),
  })
  .superRefine((data, ctx) => {
    if (!data.is_seasonal) return;
    if (!data.seasonal_start_date || !data.seasonal_end_date) {
      ctx.addIssue({ code: 'custom', path: ['seasonal_start_date'], message: 'Seasonal products require both a start and end date' });
      return;
    }
    if (data.seasonal_end_date < data.seasonal_start_date) {
      ctx.addIssue({ code: 'custom', path: ['seasonal_end_date'], message: 'End date must not be before the start date' });
    }
  });

type FormValues = z.infer<typeof formSchema>;

function valuesFromProduct(product: ProductDetailResponse): FormValues {
  return {
    name: product.name,
    description: product.description ?? '',
    category_id: product.category_id ?? NO_CATEGORY,
    display_order: product.display_order === null ? '' : String(product.display_order),
    is_seasonal: product.is_seasonal,
    seasonal_start_date: product.seasonal_start_date ?? '',
    seasonal_end_date: product.seasonal_end_date ?? '',
  };
}

interface ProductDetailsFormProps {
  product: ProductDetailResponse;
  disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
}

/**
 * POS-PERF-P39 — the product editor's Details tab. Unlike every other tab,
 * these fields are staged: nothing is sent until Save details, and Discard
 * changes puts back what is saved. The save carries the version the form was
 * loaded from, so a newer save by someone else is refused (409
 * PRODUCT_CONFLICT) instead of overwritten; the typed values stay in place
 * until the supervisor chooses to load the latest. The photo is separate and
 * saves as soon as it is chosen, as the section says.
 */
export function ProductDetailsForm({ product, disabled, onDirtyChange }: ProductDetailsFormProps) {
  const updateProduct = useUpdateProduct(product.id);
  const { data: categoryData, isLoading: categoriesLoading } = useProductCategories({ isActive: true, limit: 100 });
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: valuesFromProduct(product) });
  const isDirty = form.formState.isDirty;
  const isSeasonal = form.watch('is_seasonal');
  // The version these fields were loaded from — what Save details claims to be editing.
  const baseVersion = useRef(product.version);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { data: imageData, isLoading: imageLoading } = useProductImage(product.id, product.has_image);
  const uploadImage = useUploadProductImage();
  const deleteImage = useDeleteProductImage();

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  // A newer saved version (another supervisor, or this editor's own save)
  // refreshes the fields only while nothing is typed; otherwise the typed
  // values stay and the notice below says the saved product moved on.
  // Versions only go up: an older one is this editor's own save still being
  // refetched, not a change made elsewhere.
  useEffect(() => {
    if (product.version <= baseVersion.current) return;
    if (!form.formState.isDirty) {
      baseVersion.current = product.version;
      form.reset(valuesFromProduct(product));
      setConflict(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new saved version matters here
  }, [product.version]);

  const newerVersionSaved = product.version > baseVersion.current;

  async function onSubmit(values: FormValues) {
    setSaveError(null);
    setConflict(false);
    try {
      const saved = await updateProduct.mutateAsync({
        name: values.name.trim(),
        description: values.description || undefined,
        category_id: values.category_id === NO_CATEGORY ? null : values.category_id,
        ...(values.display_order !== '' && { display_order: Number(values.display_order) }),
        is_seasonal: values.is_seasonal,
        seasonal_start_date: values.is_seasonal ? values.seasonal_start_date : null,
        seasonal_end_date: values.is_seasonal ? values.seasonal_end_date : null,
        expected_version: baseVersion.current,
      });
      baseVersion.current = saved.version;
      form.reset(valuesFromProduct(saved));
    } catch (error) {
      if (error instanceof ProductApiError && error.code === 'PRODUCT_CONFLICT') {
        setConflict(true);
        return;
      }
      setSaveError(error instanceof Error ? error.message : 'Failed to save the details.');
    }
  }

  function loadLatest() {
    baseVersion.current = product.version;
    form.reset(valuesFromProduct(product));
    setConflict(false);
    setSaveError(null);
  }

  return (
    <div className="space-y-6">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" aria-label="Product details">
          <fieldset disabled={disabled || updateProduct.isPending} className="space-y-4">
            <FormFieldWrapper<FormValues> name="name" label="Product Name" required>
              <Input placeholder="Cheese Fries" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="description" label="Description">
              <Textarea placeholder="Optional description" rows={3} />
            </FormFieldWrapper>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="product-editor-category">Category</Label>
                <Select
                  value={form.watch('category_id')}
                  onValueChange={(value) => form.setValue('category_id', value, { shouldDirty: true })}
                  disabled={disabled || categoriesLoading}
                >
                  <SelectTrigger id="product-editor-category">
                    <SelectValue placeholder={categoriesLoading ? 'Loading…' : 'Select a category'} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_CATEGORY}>Uncategorized</SelectItem>
                    {(categoryData?.categories ?? []).map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.name}
                      </SelectItem>
                    ))}
                    {/* The saved category may since have been deactivated; keep it selectable rather than silently clearing it. */}
                    {product.category_id && !(categoryData?.categories ?? []).some((c) => c.id === product.category_id) && (
                      <SelectItem value={product.category_id}>{product.category_name ?? 'Current category'}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <FormFieldWrapper<FormValues> name="display_order" label="Display Order">
                <Input inputMode="numeric" placeholder="0" />
              </FormFieldWrapper>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div>
                <p className="text-sm font-medium" id="product-editor-seasonal-label">
                  Seasonal Product
                </p>
                <p className="text-xs text-muted-foreground">Only available within a date range.</p>
              </div>
              <Switch
                aria-labelledby="product-editor-seasonal-label"
                checked={isSeasonal}
                onCheckedChange={(checked) => form.setValue('is_seasonal', checked, { shouldDirty: true })}
              />
            </div>

            {isSeasonal && (
              <div className="grid gap-4 sm:grid-cols-2">
                <FormFieldWrapper<FormValues> name="seasonal_start_date" label="Start Date" required>
                  <Input type="date" />
                </FormFieldWrapper>
                <FormFieldWrapper<FormValues> name="seasonal_end_date" label="End Date" required>
                  <Input type="date" />
                </FormFieldWrapper>
              </div>
            )}
          </fieldset>

          {(conflict || (newerVersionSaved && isDirty)) && (
            <Alert variant="destructive" data-testid="product-details-conflict">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>{conflict ? 'Not saved — this product was changed elsewhere' : 'This product was changed elsewhere'}</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>
                  A newer version of these details was saved after you opened them. Saving yours would overwrite it, so it is refused. Your
                  typed changes are still here.
                </p>
                <Button type="button" size="sm" variant="outline" onClick={loadLatest}>
                  Load latest (discards your changes)
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {saveError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Couldn&apos;t save the details</AlertTitle>
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
              {isDirty ? 'Unsaved changes' : 'All details saved'}
            </span>
            <Button type="button" variant="outline" disabled={!isDirty || updateProduct.isPending} onClick={() => form.reset()}>
              Discard changes
            </Button>
            <Button type="submit" disabled={disabled || !isDirty || updateProduct.isPending}>
              {updateProduct.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save details
            </Button>
          </div>
        </form>
      </Form>

      <section className="space-y-2 border-t pt-4" aria-labelledby="product-editor-photo">
        <div>
          <h3 id="product-editor-photo" className="text-sm font-medium">
            Photo
          </h3>
          <p className="text-xs text-muted-foreground">Saves as soon as you upload or remove it. Shown in the product list and on POS.</p>
        </div>
        {product.has_image && (
          <div className="flex items-center gap-3">
            {imageLoading || !imageData?.image_url ? (
              <div className="h-16 w-16 shrink-0 animate-pulse rounded-md bg-muted" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Supabase Storage URL
              <img src={imageData.image_url} alt={product.name} className="h-16 w-16 shrink-0 rounded-md border object-cover" />
            )}
            {!disabled && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void deleteImage.mutateAsync({ productId: product.id })}
                disabled={deleteImage.isPending || imageLoading}
              >
                {deleteImage.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                Remove photo
              </Button>
            )}
          </div>
        )}
        {!product.has_image && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ImageIcon className="h-4 w-4" aria-hidden="true" />
            No photo yet.
          </p>
        )}
        {!disabled && (
          <ImageUpload
            label={product.has_image ? 'Replace Photo' : 'Upload Photo'}
            description="JPEG, PNG, or WebP, up to 5MB."
            onImageSelected={async (file) => {
              await uploadImage.mutateAsync({ productId: product.id, file });
            }}
          />
        )}
      </section>
    </div>
  );
}
