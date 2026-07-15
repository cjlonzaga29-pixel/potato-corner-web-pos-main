'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useCreateProduct } from '@/hooks/queries/use-products';
import { useBranches } from '@/hooks/queries/use-branches';

/** Empty string -> undefined (skips validation for optional fields) before coercing to a number. */
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
    display_order: optionalCoercedNumber(0),
    status: z.enum(['draft', 'active']),
    is_seasonal: z.boolean(),
    seasonal_start_date: z.string().optional(),
    seasonal_end_date: z.string().optional(),
    branch_exclusive: z.boolean(),
    exclusive_branch_id: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.is_seasonal) {
      if (!data.seasonal_start_date || !data.seasonal_end_date) {
        ctx.addIssue({ code: 'custom', path: ['seasonal_start_date'], message: 'Seasonal products require both a start and end date' });
      } else if (data.seasonal_end_date < data.seasonal_start_date) {
        ctx.addIssue({ code: 'custom', path: ['seasonal_end_date'], message: 'End date must not be before the start date' });
      }
    }
    if (data.branch_exclusive && !data.exclusive_branch_id) {
      ctx.addIssue({ code: 'custom', path: ['exclusive_branch_id'], message: 'Select the exclusive branch' });
    }
  });

type FormValues = z.input<typeof formSchema>;

const DEFAULT_VALUES: FormValues = {
  name: '',
  description: '',
  category: '',
  display_order: '',
  status: 'draft',
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

export function CreateProductDialog({ open, onOpenChange }: CreateProductDialogProps) {
  const createProduct = useCreateProduct();
  const { data: branchData } = useBranches({ status: 'active', limit: 100 });
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: DEFAULT_VALUES });
  const isSeasonal = form.watch('is_seasonal');
  const branchExclusive = form.watch('branch_exclusive');

  function handleOpenChange(next: boolean) {
    if (!next) form.reset(DEFAULT_VALUES);
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await createProduct.mutateAsync({
      name: parsed.name,
      description: parsed.description || undefined,
      category: parsed.category || undefined,
      display_order: parsed.display_order,
      status: parsed.status,
      is_seasonal: parsed.is_seasonal,
      seasonal_start_date: parsed.is_seasonal ? parsed.seasonal_start_date : undefined,
      seasonal_end_date: parsed.is_seasonal ? parsed.seasonal_end_date : undefined,
      branch_exclusive: parsed.branch_exclusive,
      exclusive_branch_id: parsed.branch_exclusive ? parsed.exclusive_branch_id : undefined,
    });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Product</DialogTitle>
          <DialogDescription>New products start as draft or active — other statuses require a lifecycle change afterward.</DialogDescription>
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

            {/* Radix Select takes value/onValueChange, not the onChange FormFieldWrapper clones onto children — wired directly via Controller instead. */}
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Initial Status<span className="ml-0.5 text-destructive">*</span>
                  </FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="active">Active</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

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

            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Make this a branch-exclusive product</p>
                  <p className="text-xs text-muted-foreground">
                    {branchExclusive
                      ? 'Only the selected branch will get this product — no other branch is affected.'
                      : 'By default, creating a product cascades it to every active branch immediately.'}
                  </p>
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
                <FormField
                  control={form.control}
                  name="exclusive_branch_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Exclusive Branch<span className="ml-0.5 text-destructive">*</span>
                      </FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a branch" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {branchData?.branches.map((branch) => (
                            <SelectItem key={branch.id} value={branch.id}>
                              {branch.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>

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
