'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useCreateProduct } from '@/hooks/queries/use-products';
import { useBranches } from '@/hooks/queries/use-branches';

function optionalCoercedNumber(min: number) {
  return z.preprocess(
    (value) => (value === '' || value === undefined || value === null ? undefined : value),
    z.coerce.number().int().min(min).optional(),
  );
}

const formSchema = z
  .object({
    name: z.string().min(2, 'Minimum 2 characters').max(100),
    description: z.string().max(500).optional(),
    category: z.string().max(50).optional(),
    status: z.enum(['draft', 'active']),
    display_order: optionalCoercedNumber(0),
    is_seasonal: z.boolean(),
    seasonal_start_date: z.string().optional(),
    seasonal_end_date: z.string().optional(),
    branch_exclusive: z.boolean(),
    exclusive_branch_id: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.is_seasonal && (!data.seasonal_start_date || !data.seasonal_end_date)) {
      ctx.addIssue({ code: 'custom', path: ['seasonal_start_date'], message: 'Seasonal products require both a start and end date' });
    }
    if (data.is_seasonal && data.seasonal_start_date && data.seasonal_end_date && data.seasonal_end_date < data.seasonal_start_date) {
      ctx.addIssue({ code: 'custom', path: ['seasonal_end_date'], message: 'End date must not be before the start date' });
    }
    if (data.branch_exclusive && !data.exclusive_branch_id) {
      ctx.addIssue({ code: 'custom', path: ['exclusive_branch_id'], message: 'Select a branch for a branch-exclusive product' });
    }
  });

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  name: '',
  description: '',
  category: '',
  status: 'draft',
  display_order: '',
  is_seasonal: false,
  seasonal_start_date: '',
  seasonal_end_date: '',
  branch_exclusive: false,
  exclusive_branch_id: '',
};

interface CreateProductDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Product Management is the sole source of truth for new products (Product Request workflow removed) — created here as draft/active, then variants, flavors, and ProductInventory mappings are added from the product's own detail page. */
export function CreateProductDialog({ open, onOpenChange }: CreateProductDialogProps) {
  const router = useRouter();
  const createProduct = useCreateProduct();
  const { data: branchData, isLoading: branchesLoading } = useBranches({ status: 'active', limit: 100 });
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const isSeasonal = form.watch('is_seasonal');
  const branchExclusive = form.watch('branch_exclusive');

  useEffect(() => {
    if (open) form.reset(DEFAULT_VALUES);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-sync when the dialog opens
  }, [open]);

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    const created = await createProduct.mutateAsync({
      name: parsed.name,
      description: parsed.description || undefined,
      category: parsed.category || undefined,
      status: parsed.status,
      display_order: parsed.display_order,
      is_seasonal: parsed.is_seasonal,
      seasonal_start_date: parsed.is_seasonal ? parsed.seasonal_start_date : undefined,
      seasonal_end_date: parsed.is_seasonal ? parsed.seasonal_end_date : undefined,
      branch_exclusive: parsed.branch_exclusive,
      exclusive_branch_id: parsed.branch_exclusive ? parsed.exclusive_branch_id : undefined,
    });
    handleOpenChange(false);
    router.push(`/admin/products/${created.id}`);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Product</DialogTitle>
          <DialogDescription>Add variants, flavors, and inventory mappings from the product&apos;s detail page after it&apos;s created.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormFieldWrapper<FormValues> name="name" label="Product Name" required>
              <Input placeholder="Cheese Fries" />
            </FormFieldWrapper>

            <FormFieldWrapper<FormValues> name="description" label="Description">
              <Textarea placeholder="Optional description" rows={3} />
            </FormFieldWrapper>

            <div className="grid grid-cols-2 gap-3">
              <FormFieldWrapper<FormValues> name="category" label="Category">
                <Input placeholder="Fries" />
              </FormFieldWrapper>
              <FormFieldWrapper<FormValues> name="display_order" label="Display Order">
                <Input inputMode="numeric" placeholder="0" />
              </FormFieldWrapper>
            </div>

            <div className="space-y-2">
              <Label htmlFor="create-product-status">Initial Status</Label>
              <Select value={form.watch('status')} onValueChange={(value) => form.setValue('status', value as 'draft' | 'active')}>
                <SelectTrigger id="create-product-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Seasonal Product</p>
                <p className="text-xs text-muted-foreground">Only available within a date range.</p>
              </div>
              <Switch checked={isSeasonal} onCheckedChange={(checked) => form.setValue('is_seasonal', checked)} />
            </div>

            {isSeasonal && (
              <div className="grid grid-cols-2 gap-3">
                <FormFieldWrapper<FormValues> name="seasonal_start_date" label="Start Date" required>
                  <Input type="date" />
                </FormFieldWrapper>
                <FormFieldWrapper<FormValues> name="seasonal_end_date" label="End Date" required>
                  <Input type="date" />
                </FormFieldWrapper>
              </div>
            )}

            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Branch-Exclusive</p>
                <p className="text-xs text-muted-foreground">Available only at one branch instead of every active branch.</p>
              </div>
              <Switch
                checked={branchExclusive}
                onCheckedChange={(checked) => {
                  form.setValue('branch_exclusive', checked);
                  if (!checked) form.setValue('exclusive_branch_id', '');
                }}
              />
            </div>

            {branchExclusive && (
              <div className="space-y-2">
                <Label htmlFor="create-product-branch">Exclusive Branch</Label>
                <Select
                  value={form.watch('exclusive_branch_id')}
                  onValueChange={(value) => form.setValue('exclusive_branch_id', value)}
                  disabled={branchesLoading}
                >
                  <SelectTrigger id="create-product-branch">
                    <SelectValue placeholder={branchesLoading ? 'Loading…' : 'Select a branch'} />
                  </SelectTrigger>
                  <SelectContent>
                    {(branchData?.branches ?? []).map((branch) => (
                      <SelectItem key={branch.id} value={branch.id}>
                        {branch.name} ({branch.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createProduct.isPending}>
                {createProduct.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Product
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
