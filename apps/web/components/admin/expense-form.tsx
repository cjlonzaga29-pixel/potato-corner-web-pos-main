'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { createExpenseSchema } from '@potato-corner/shared';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { CurrencyInput } from '@/components/shared/forms/currency-input';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranches } from '@/hooks/queries/use-branches';
import type { CreateExpenseInput, ExpenseCategory } from '@/hooks/queries/use-expenses';

const CATEGORY_OPTIONS: { value: ExpenseCategory; label: string }[] = [
  { value: 'utilities', label: 'Utilities' },
  { value: 'supplies', label: 'Supplies' },
  { value: 'staff_meals', label: 'Staff Meals' },
  { value: 'miscellaneous', label: 'Miscellaneous' },
];

const formSchema = createExpenseSchema.extend({
  incurred_at: z.string().min(1, 'Date is required'),
});

type FormValues = z.input<typeof formSchema>;

export type ExpenseFormValues = CreateExpenseInput;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function toDefaultValues(initialValues?: Partial<ExpenseFormValues>): FormValues {
  return {
    branch_id: initialValues?.branch_id ?? '',
    category: initialValues?.category ?? 'utilities',
    amount: initialValues?.amount ?? 0,
    vendor_name: initialValues?.vendor_name ?? '',
    description: initialValues?.description ?? '',
    incurred_at: initialValues?.incurred_at ? initialValues.incurred_at.slice(0, 10) : today(),
  };
}

interface ExpenseFormProps {
  mode: 'create' | 'edit';
  initialValues?: Partial<ExpenseFormValues>;
  onSubmit: (values: ExpenseFormValues) => Promise<void>;
  isSubmitting: boolean;
  onCancel: () => void;
}

export function ExpenseForm({ mode, initialValues, onSubmit, isSubmitting, onCancel }: ExpenseFormProps) {
  const { data: branchData, isLoading: branchesLoading } = useBranches({ status: 'active', limit: 100 });
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: toDefaultValues(initialValues) });

  async function handleSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await onSubmit({
      branch_id: parsed.branch_id,
      category: parsed.category as ExpenseCategory,
      amount: parsed.amount,
      vendor_name: parsed.vendor_name || undefined,
      description: parsed.description || undefined,
      incurred_at: new Date(parsed.incurred_at).toISOString(),
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="branch_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Branch<span className="ml-0.5 text-destructive">*</span>
              </FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger disabled={branchesLoading}>
                    <SelectValue placeholder="Select a branch" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {(branchData?.branches ?? []).map((branch) => (
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

        <FormField
          control={form.control}
          name="category"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Category<span className="ml-0.5 text-destructive">*</span>
              </FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a category" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {CATEGORY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* CurrencyInput's onChange(value: number) doesn't match the (event) signature FormFieldWrapper clones onto children — wired directly via Controller instead. */}
        <FormField
          control={form.control}
          name="amount"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Amount<span className="ml-0.5 text-destructive">*</span>
              </FormLabel>
              <FormControl>
                <CurrencyInput
                  value={typeof field.value === 'number' ? field.value : Number(field.value)}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  name="amount"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormFieldWrapper<FormValues> name="vendor_name" label="Vendor Name" description="Optional">
          <Input placeholder="Meralco" />
        </FormFieldWrapper>

        <FormFieldWrapper<FormValues> name="description" label="Description" description="Optional, up to 500 characters">
          <Textarea maxLength={500} rows={3} placeholder="Optional notes about this expense" />
        </FormFieldWrapper>

        <FormFieldWrapper<FormValues> name="incurred_at" label="Date Incurred" required>
          <Input type="date" />
        </FormFieldWrapper>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting || branchesLoading}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {mode === 'create' ? 'Create Expense' : 'Save Changes'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
