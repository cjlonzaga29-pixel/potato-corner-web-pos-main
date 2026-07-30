'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { ROLES } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Form, FormControl, FormItem, FormLabel, FormMessage, FormField } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DenominationTable, denominationEntries, denominationTotal, type DenominationQuantities } from '@/components/pos/denomination-table';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { useAuth } from '@/hooks/use-auth';
import { useEmployees } from '@/hooks/queries/use-employees';
import { useIsClockedIn } from '@/hooks/queries/use-attendance';
import { useMyActiveShift, useOpenShift, useShiftsRealtimeSync } from '@/hooks/queries/use-shifts';

const formSchema = z.object({ cashier_id: z.uuid('Select who this shift is for') });
type FormValues = z.infer<typeof formSchema>;

export default function OpenShiftPage() {
  const router = useRouter();
  const { user } = useAuth();
  const branchId = user?.branchIds[0];
  const [quantities, setQuantities] = useState<DenominationQuantities>({});
  const openShift = useOpenShift(branchId);
  useShiftsRealtimeSync();

  // Only a supervisor/super_admin may open a shift on behalf of someone
  // else. A `branch`/`staff` account is the one that will actually swipe
  // the POS — the shift's cashier_id must match req.user.user_id or
  // shiftGuard rejects checkout with NO_ACTIVE_SHIFT even though this
  // branch-wide "is a shift open" page shows ACTIVE (findActiveShiftByBranch
  // has no cashier filter, unlike shiftGuard's findActiveShift).
  const canOpenForOthers = user?.role === ROLES.SUPERVISOR || user?.role === ROLES.SUPER_ADMIN;

  // Attendance and "is this already my open shift" gating only apply to the
  // self-service cashier flow (Clock In -> Open Shift once -> POS). A
  // supervisor/super_admin isn't the one swiping the POS, so their own
  // attendance record is irrelevant here — they only need to be blocked
  // from opening a *second* shift once one exists (handled below via
  // `shift`, regardless of whose it is).
  const { isClockedIn, isLoading: isAttendanceLoading } = useIsClockedIn();
  const { shift, isMine, belongsToAnother, isLoading: isShiftLoading } = useMyActiveShift(branchId);

  const { data: staffList } = useEmployees({ role: 'staff', branchId, isActive: true });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { cashier_id: user?.id ?? '' },
  });

  const total = denominationTotal(quantities);
  const entries = denominationEntries(quantities);

  const redirectingToClockIn = !canOpenForOthers && !isAttendanceLoading && !isClockedIn;
  const redirectingToPos = !canOpenForOthers && isMine;

  useEffect(() => {
    if (redirectingToClockIn) router.replace('/branch/clock-in');
  }, [redirectingToClockIn, router]);

  useEffect(() => {
    if (redirectingToPos) router.replace('/branch/terminal');
  }, [redirectingToPos, router]);

  // A ref (not openShift.isPending) guards against a double-click firing a
  // second open-shift request — isPending only flips after React re-renders
  // the mutation hook's state, which is too late to catch two fireEvent
  // clicks (or a fast double-tap) dispatched before that render happens.
  const isSubmittingRef = useRef(false);

  async function onSubmit(values: FormValues) {
    if (!branchId || entries.length === 0 || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    try {
      await openShift.mutateAsync({
        branch_id: branchId,
        cashier_id: values.cashier_id,
        starting_cash: total,
        denominations: entries,
      });
      router.push('/branch/terminal');
    } finally {
      isSubmittingRef.current = false;
    }
  }

  if (!branchId) {
    return <p className="p-6 text-sm text-destructive">No branch assigned — cannot open a shift.</p>;
  }

  if ((!canOpenForOthers && isAttendanceLoading) || isShiftLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  // Redirect in flight — render nothing rather than flashing the form or a
  // stale "shift already open" panel first.
  if (redirectingToClockIn || redirectingToPos) {
    return null;
  }

  if (shift !== null) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-6 text-center">
        <Card>
          <CardContent className="space-y-3 pt-6">
            <h1 className="text-xl font-bold">A shift is already open</h1>
            <p className="text-sm text-muted-foreground">
              {belongsToAnother
                ? 'This branch already has an active shift open under a different cashier account. Only one shift can be open at a time — close it before opening a new one.'
                : 'Your shift is already open at this branch.'}
            </p>
            <Button onClick={() => router.push(isMine ? '/branch/terminal' : '/branch/shift')}>
              {isMine ? 'Go to POS' : 'View Current Shift'}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
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
                <Select value={field.value} onValueChange={field.onChange} disabled={!canOpenForOthers}>
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
                    {canOpenForOthers &&
                      staffList?.employees
                        .filter((e) => e.id !== user?.id)
                        .map((e) => (
                          <SelectItem key={e.id} value={e.id}>
                            {`${e.first_name} ${e.last_name}`.trim() || e.email}
                          </SelectItem>
                        ))}
                  </SelectContent>
                </Select>
                {!canOpenForOthers && (
                  <p className="text-xs text-muted-foreground">
                    Shifts must be opened under your own account — you&apos;ll be blocked from checkout otherwise.
                  </p>
                )}
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
