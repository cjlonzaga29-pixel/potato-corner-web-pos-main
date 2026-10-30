'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react';
import type { PayrollIssue } from '@potato-corner/shared';
import { Button } from '@/components/ui/button';
import { useResolvePayrollIssue } from '@/hooks/queries/use-payroll';
import { PayrollReasonDialog } from './payroll-reason-dialog';

interface Props {
  branchId: string;
  runId: string;
  issues: PayrollIssue[];
  names: Map<string, string>;
  editable: boolean;
}

const ORDER = { blocking: 0, special_pay: 1, warning: 2, info: 3 } as const;
const HEADINGS = {
  blocking: 'Blocking — fix before finalizing',
  special_pay: 'Special pay — record how each is handled',
  warning: 'Warnings — covered by the scope acknowledgement',
  info: 'For information',
} as const;

/** Issues grouped by severity. Special-pay items take a reviewer note; nothing here changes attendance or computes a premium. */
export function PayrollIssuesList({ branchId, runId, issues, names, editable }: Props) {
  const [resolving, setResolving] = useState<PayrollIssue | null>(null);
  const resolve = useResolvePayrollIssue(branchId, runId);
  if (issues.length === 0) return <p className="text-sm text-muted-foreground">No issues found.</p>;
  const groups = (Object.keys(HEADINGS) as Array<keyof typeof HEADINGS>)
    .map((severity) => ({ severity, items: issues.filter((i) => i.severity === severity) }))
    .filter((g) => g.items.length > 0)
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);

  return (
    <div className="grid gap-4">
      {groups.map((group) => (
        <section key={group.severity} aria-label={HEADINGS[group.severity]}>
          <h3 className="mb-2 text-sm font-semibold">
            {HEADINGS[group.severity]} ({group.items.length})
          </h3>
          <ul className="grid gap-2">
            {group.items.map((issue) => (
              <li key={issue.key} className="flex flex-wrap items-start gap-3 rounded-lg border p-3 text-sm">
                <IssueIcon issue={issue} />
                <div className="min-w-0 flex-1">
                  <p className="break-words">
                    {issue.employee_id && <span className="font-medium">{names.get(issue.employee_id) ?? 'Employee'}: </span>}
                    {issue.business_date && <span className="text-muted-foreground">{issue.business_date} · </span>}
                    {issue.message}
                  </p>
                  {issue.resolution && (
                    <p className="mt-1 break-words text-xs text-muted-foreground">
                      Resolved by {issue.resolution.by}: “{issue.resolution.note}”
                    </p>
                  )}
                </div>
                {editable && issue.severity === 'special_pay' && !issue.resolution && (
                  <Button size="sm" variant="outline" className="min-h-10" onClick={() => setResolving(issue)}>
                    Record resolution
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <PayrollReasonDialog
        open={resolving !== null}
        onOpenChange={(open) => !open && setResolving(null)}
        title="Record how this is handled"
        description={resolving ? `${resolving.message} The system does not calculate this premium; your note is kept with the payroll.` : ''}
        fieldLabel="Resolution note"
        confirmLabel="Save note"
        isPending={resolve.isPending}
        onConfirm={(note) => resolving && resolve.mutate({ issue_key: resolving.key, note }, { onSuccess: () => setResolving(null) })}
      />
    </div>
  );
}

function IssueIcon({ issue }: { issue: PayrollIssue }) {
  if (issue.severity === 'blocking') return <OctagonAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-label="Blocking" />;
  if (issue.severity === 'special_pay') {
    return issue.resolution ? (
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Resolved" />
    ) : (
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-label="Needs a resolution" />
    );
  }
  if (issue.severity === 'warning') return <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-label="Warning" />;
  return <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-label="Information" />;
}
