'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormItem, FormLabel, FormMessage, FormField } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DenominationTable, denominationEntries, denominationTotal, type DenominationQuantities } from '@/components/pos/denomination-table';
import { useAuth } from '@/hooks/use-auth';
import { useEmployees } from '@/hooks/queries/use-employees';
import { useOpenShift } from '@/hooks/queries/use-shifts';

const formSchema = z.object({ cashier_id: z.uuid('Select who this shift is for') });
type FormValues = z.infer<typeof formSchema>;

export default function OpenShiftPage() {
  const router = useRouter();
  const { user } = useAuth();
  const branchId = user?.branchIds[0];
  const [quantities, setQuantities] = useState<DenominationQuantities>({});
  const openShift = useOpenShift(branchId);

  // Only a supervisor can open a shift on behalf of someone else — staff
  // can only ever open their own (POST /open is supervisor/super_admin
  // only anyway, so a staff member never reaches this page as themselves
  // in the "open for a cashier" sense, but the form still defaults to self).
  const { data: staffList } = useEmployees({ role: 'staff', branchId, isActive: true });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { cashier_id: user?.id ?? '' },
  });

  const total = denominationTotal(quantities);
  const entries = denominationEntries(quantities);

  async function onSubmit(values: FormValues) {
    if (!branchId || entries.length === 0) return;
    await openShift.mutateAsync({
      branch_id: branchId,
      cashier_id: values.cashier_id,
      starting_cash: total,
      denominations: entries,
    });
    router.push('/shift');
  }

  if (!branchId) {
    return <p className="p-6 text-sm text-destructive">No branch assigned — cannot open a shift.</p>;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 overflow-y-auto p-6">
      <div>
        <h1 className="text-2xl font-bold">Open Shift</h1>
        <p className="text-sm text-muted-foreground">Count the starting cash drawer and enter the breakdown below.</p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <FormField
            control={form.control}
            name="cashier_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Cashier<span className="ml-0.5 text-destructive">*</span>
                </FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a cashier" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {user && (
                      <SelectItem value={user.id}>
                        {`${user.firstName} ${user.lastName}`.trim() || user.email} (me)
                      </SelectItem>
                    )}
                    {staffList?.employees
                      .filter((e) => e.id !== user?.id)
                      .map((e) => (
                        <SelectItem key={e.id} value={e.id}>
                          {`${e.first_name} ${e.last_name}`.trim() || e.email}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <DenominationTable quantities={quantities} onChange={(d, q) => setQuantities((prev) => ({ ...prev, [d]: q }))} />
          {entries.length === 0 && <p className="text-sm text-destructive">Enter at least one denomination.</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={openShift.isPending || entries.length === 0}>
              {openShift.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Open Shift
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
