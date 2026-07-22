import { CheckCircle2, XCircle } from 'lucide-react';
import type { BulkAssignGcashQrResult } from '@/hooks/queries/use-branches';

interface BulkAssignResultProps {
  result: BulkAssignGcashQrResult;
  branchName: (branchId: string) => string;
}

/** Success/failure summary panel shown after a bulk GCash QR assignment completes. */
export function BulkAssignResult({ result, branchName }: BulkAssignResultProps) {
  return (
    <div className="space-y-4">
      {result.successful.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
            Assigned successfully ({result.successful.length})
          </p>
          <ul className="space-y-1">
            {result.successful.map((item) => (
              <li
                key={item.branchId}
                className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm dark:border-emerald-900 dark:bg-emerald-950"
              >
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                <span>{branchName(item.branchId)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.failed.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-destructive">Failed ({result.failed.length})</p>
          <ul className="space-y-1">
            {result.failed.map((item) => (
              <li
                key={item.branchId}
                className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm"
              >
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                <span>
                  <span className="font-medium">{branchName(item.branchId)}</span>
                  <span className="block text-xs text-muted-foreground">{item.error}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
