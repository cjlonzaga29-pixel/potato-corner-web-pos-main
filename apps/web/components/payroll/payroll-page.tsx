'use client';

import { useEffect, useState } from 'react';
import { Settings } from 'lucide-react';
import { BranchCombobox } from '@/components/shared/branch-combobox';
import { Button } from '@/components/ui/button';
import { ReportsSectionTabs } from '@/components/reports/reports-section-tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { useBranches } from '@/hooks/queries/use-branches';
import { useBranchStore } from '@/stores/branch.store';
import { PayrollRunsPanel, type PayrollSelection } from './payroll-runs-panel';
import { PayrollSettingsPanel } from './payroll-settings-panel';

const EMPTY_SELECTION: PayrollSelection = { periodKey: null, runId: null };

/**
 * POS-PERF-P52 — Reports → Payroll. Supervisors work on the active branch
 * chosen in the sidebar (their current assignments only); Super Admin picks
 * any branch here. The server enforces the same scope on every request.
 *
 * POS-PERF-P66 — one "Payroll Settings" entry (no settings tab), a setup
 * checklist when something is missing, then choose period → review →
 * finalize. Saving the policy returns to the flow with the period and run
 * still selected. Nothing about calculation or permissions changes.
 */
export function PayrollPage({ scope }: { scope: 'supervisor' | 'admin' }) {
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const [adminBranchId, setAdminBranchId] = useState<string | undefined>(undefined);
  const branches = useBranches({ limit: 100 });
  const branchId = scope === 'supervisor' ? activeBranchId : (adminBranchId ?? null);
  const activeBranchName = useBranchStore((s) => s.activeBranch?.name) ?? branches.data?.branches.find((b) => b.id === activeBranchId)?.name;
  const [view, setView] = useState<'payroll' | 'settings'>('payroll');
  // Selection belongs to one branch: a different branch starts clean instead of reusing another branch's period or run.
  const [selection, setSelection] = useState<{ branchId: string | null } & PayrollSelection>({ branchId: null, ...EMPTY_SELECTION });
  const branchSelection = selection.branchId === branchId ? selection : EMPTY_SELECTION;

  // POS-PERF-P56 — `?tab=settings` is the Payroll Settings link's destination. Read after mount so the server and first client render agree.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'settings') setView('settings');
  }, []);

  const openSettings = () => {
    setView('settings');
    window.scrollTo?.({ top: 0 });
  };

  return (
    <div className="app-section app-section-gap space-y-4">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="app-title font-semibold">{view === 'settings' ? 'Payroll Settings' : 'Payroll'}</h1>
            <p className="app-subtitle text-muted-foreground">
              Attendance-based basic pay. Statutory deductions, contributions and taxes are not included, and nothing here pays anyone.
            </p>
          </div>
          {view === 'payroll' && (
            <Button type="button" variant="outline" className="min-h-10 w-full gap-2 sm:w-auto" onClick={openSettings} disabled={!branchId}>
              <Settings className="h-4 w-4" aria-hidden="true" />
              Payroll Settings
            </Button>
          )}
        </div>
        {scope === 'admin' && <ReportsSectionTabs basePath="/admin/reports" />}
      </div>

      {scope === 'admin' ? (
        <div className="grid gap-2 sm:max-w-sm">
          <Label>Branch</Label>
          <BranchCombobox
            branches={(branches.data?.branches ?? []).map((b) => ({ id: b.id, name: b.name, code: b.code }))}
            value={adminBranchId}
            onChange={setAdminBranchId}
            placeholder="Select a branch…"
          />
        </div>
      ) : (
        branchId && (
          <p className="text-sm" data-testid="payroll-branch">
            Branch: <span className="font-medium">{activeBranchName ?? 'Selected branch'}</span>
            <span className="text-muted-foreground"> · change it in the branch selector</span>
          </p>
        )
      )}

      {!branchId ? (
        <Alert>
          <AlertTitle>Select a branch</AlertTitle>
          <AlertDescription>
            {scope === 'supervisor' ? 'Choose one of your branches in the branch selector to see its payroll.' : 'Choose a branch above to see its payroll.'}
          </AlertDescription>
        </Alert>
      ) : view === 'settings' ? (
        <PayrollSettingsPanel key={branchId} branchId={branchId} onDone={() => setView('payroll')} />
      ) : (
        <PayrollRunsPanel
          key={branchId}
          branchId={branchId}
          onConfigure={openSettings}
          selection={branchSelection}
          onSelectionChange={(next) => setSelection({ branchId, ...next })}
        />
      )}
    </div>
  );
}
