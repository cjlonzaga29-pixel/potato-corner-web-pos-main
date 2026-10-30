'use client';

import { useState } from 'react';
import { BranchCombobox } from '@/components/shared/branch-combobox';
import { ReportsSectionTabs } from '@/components/reports/reports-section-tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useBranches } from '@/hooks/queries/use-branches';
import { useBranchStore } from '@/stores/branch.store';
import { PayrollRunsPanel } from './payroll-runs-panel';
import { PayrollSettingsPanel } from './payroll-settings-panel';

/**
 * POS-PERF-P52 — Reports → Payroll. Supervisors work on the active branch
 * chosen in the sidebar (their current assignments only); Super Admin picks
 * any branch here. The server enforces the same scope on every request.
 */
export function PayrollPage({ scope }: { scope: 'supervisor' | 'admin' }) {
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const [adminBranchId, setAdminBranchId] = useState<string | undefined>(undefined);
  const branches = useBranches({ limit: 100 });
  const branchId = scope === 'supervisor' ? activeBranchId : (adminBranchId ?? null);
  const [tab, setTab] = useState<'runs' | 'settings'>('runs');

  return (
    <div className="app-section app-section-gap space-y-4">
      <div className="grid gap-3">
        <div className="min-w-0">
          <h1 className="app-title font-semibold">Payroll</h1>
          <p className="app-subtitle text-muted-foreground">Attendance-based basic pay. Not statutory net pay — contributions and taxes are not included.</p>
        </div>
        <ReportsSectionTabs basePath={scope === 'supervisor' ? '/supervisor/reports' : '/admin/reports'} />
      </div>

      {scope === 'admin' && (
        <div className="grid gap-2 sm:max-w-sm">
          <Label>Branch</Label>
          <BranchCombobox
            branches={(branches.data?.branches ?? []).map((b) => ({ id: b.id, name: b.name, code: b.code }))}
            value={adminBranchId}
            onChange={setAdminBranchId}
            placeholder="Select a branch…"
          />
        </div>
      )}

      {!branchId ? (
        <Alert>
          <AlertTitle>Select a branch</AlertTitle>
          <AlertDescription>
            {scope === 'supervisor' ? 'Choose one of your branches in the branch selector to see its payroll.' : 'Choose a branch above to see its payroll.'}
          </AlertDescription>
        </Alert>
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'runs' | 'settings')} className="grid gap-4">
          <TabsList className="w-full sm:w-fit">
            <TabsTrigger value="runs" className="min-h-9 flex-1 sm:flex-none">
              Payroll runs
            </TabsTrigger>
            <TabsTrigger value="settings" className="min-h-9 flex-1 sm:flex-none">
              Pay settings
            </TabsTrigger>
          </TabsList>
          <TabsContent value="runs" className="mt-0">
            <PayrollRunsPanel key={branchId} branchId={branchId} onConfigure={() => setTab('settings')} />
          </TabsContent>
          <TabsContent value="settings" className="mt-0">
            <PayrollSettingsPanel key={branchId} branchId={branchId} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
