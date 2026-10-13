'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, AlertTriangle } from 'lucide-react';
import type { CatalogResourceType, EmployeeResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useEmployees } from '@/hooks/queries/use-employees';
import { useCatalogAssignmentPreview, useCreateCatalogAssignment } from '@/hooks/queries/use-catalog-assignment';

const formSchema = z.object({
  supervisor_id: z.string().min(1, 'Select a supervisor'),
  reason: z.string().trim().min(10, 'Explain why this assignment is needed (min. 10 characters)').max(500),
});

type FormValues = z.input<typeof formSchema>;

interface AssignManagementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceType: CatalogResourceType;
  resourceId: string;
  resourceLabel: string;
}

/**
 * POS-PERF-P35R — the one UI surface that can set managedBy. Shows the
 * read-only impact preview (current manager, how many other records
 * depend on this one and across how many other managers) before the
 * Super Admin confirms, and never lets Admin pick itself — the supervisor
 * list below is role-scoped server-side by GET /api/employees?role=supervisor.
 */
export function AssignManagementDialog({ open, onOpenChange, resourceType, resourceId, resourceLabel }: AssignManagementDialogProps) {
  const preview = useCatalogAssignmentPreview(open ? resourceType : null, open ? resourceId : null);
  const supervisors = useEmployees({ role: 'supervisor' }, { enabled: open });
  const createAssignment = useCreateCatalogAssignment();
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { supervisor_id: '', reason: '' } });

  function handleOpenChange(next: boolean) {
    if (!next) form.reset({ supervisor_id: '', reason: '' });
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    await createAssignment.mutateAsync({
      resource_type: resourceType,
      resource_id: resourceId,
      supervisor_id: parsed.supervisor_id,
      reason: parsed.reason,
    });
    handleOpenChange(false);
  }

  const activeSupervisors = (supervisors.data?.employees ?? []).filter((e: EmployeeResponse) => e.is_active);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign Catalog Management</DialogTitle>
          <DialogDescription>
            Hands a Supervisor responsibility for managing &ldquo;{resourceLabel}&rdquo;. This does not restore catalog CRUD to Admin, and does not
            change who originally created this record.
          </DialogDescription>
        </DialogHeader>

        {preview.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : preview.data ? (
          <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
            <p>
              <span className="text-muted-foreground">Currently managed by:</span>{' '}
              {preview.data.current_manager_label ?? <span className="italic">nobody (orphaned/shared record)</span>}
            </p>
            {preview.data.dependent_summary.some((d) => d.count > 0) && (
              <div className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  {preview.data.dependent_summary
                    .filter((d) => d.count > 0)
                    .map((d) => `${d.count} ${d.resource_type.toLowerCase().replace(/_/g, ' ')}(s), across ${d.distinct_other_managers} other manager(s)`)
                    .join('; ')}{' '}
                  depend on this record. This assignment never changes who manages those — only this record.
                </span>
              </div>
            )}
          </div>
        ) : null}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="supervisor_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Supervisor<span className="ml-0.5 text-destructive">*</span>
                  </FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select an active supervisor" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {activeSupervisors.map((employee: EmployeeResponse) => (
                        <SelectItem key={employee.id} value={employee.id}>
                          {employee.first_name} {employee.last_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormFieldWrapper<FormValues> name="reason" label="Reason" required description="Recorded in the audit trail — why this assignment is needed">
              <Textarea placeholder="e.g. Pre-existing shared master data, no current owner, needed for Phase 20 recipe setup" rows={3} />
            </FormFieldWrapper>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createAssignment.isPending}>
                {createAssignment.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Assign Management
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
