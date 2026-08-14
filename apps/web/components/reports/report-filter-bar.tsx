'use client';

import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranches } from '@/hooks/queries/use-branches';
import { ExportButtons } from '@/components/reports/export-buttons';

export interface ReportFilterBarProps {
  branchId: string | null;
  onBranchChange: (id: string | null) => void;
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (v: string) => void;
  onDateToChange: (v: string) => void;
  onRefresh: () => void;
  onExportCsv: () => void;
  onExportPdf: () => void;
  isRefreshDisabled: boolean;
  refreshCooldownSeconds: number;
  isExportingCsv: boolean;
  isExportingPdf: boolean;
  /** True when the active report requires a branch and none is selected — disables both export buttons without affecting the exporting spinner/label state. */
  exportDisabled?: boolean;
  showBranchSelector: boolean;
}

export function ReportFilterBar({
  branchId,
  onBranchChange,
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
  onRefresh,
  onExportCsv,
  onExportPdf,
  isRefreshDisabled,
  refreshCooldownSeconds,
  isExportingCsv,
  isExportingPdf,
  exportDisabled = false,
  showBranchSelector,
}: ReportFilterBarProps) {
  // useBranches(filters) takes a single filters argument (no `enabled` gate) — called
  // unconditionally per the rules of hooks; when showBranchSelector is false the fetched
  // list is simply never rendered, which is a cheap, cached, harmless request.
  const { data: branchesData } = useBranches({ limit: 100 });
  const branches = branchesData?.branches ?? [];

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
      {showBranchSelector && (
        <div className="w-full sm:w-auto">
          <Label htmlFor="report-filter-branch">Branch</Label>
          <Select value={branchId ?? 'all'} onValueChange={(value) => onBranchChange(value === 'all' ? null : value)}>
            <SelectTrigger id="report-filter-branch" className="w-full sm:w-[200px]">
              <SelectValue placeholder="All Branches" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Branches</SelectItem>
              {branches.map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:flex sm:w-auto sm:gap-4">
        <div className="w-full sm:w-auto">
          <Label htmlFor="report-filter-from">From</Label>
          <Input id="report-filter-from" type="date" value={dateFrom} onChange={(e) => onDateFromChange(e.target.value)} className="w-full" />
        </div>
        <div className="w-full sm:w-auto">
          <Label htmlFor="report-filter-to">To</Label>
          <Input id="report-filter-to" type="date" value={dateTo} onChange={(e) => onDateToChange(e.target.value)} className="w-full" />
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="button" variant="outline" onClick={onRefresh} disabled={isRefreshDisabled} className="w-full sm:w-auto">
          <RotateCw className="mr-2 h-4 w-4" />
          {isRefreshDisabled ? `Refresh (${refreshCooldownSeconds}s)` : 'Refresh'}
        </Button>
        <ExportButtons
          onExportCsv={onExportCsv}
          onExportPdf={onExportPdf}
          isExportingCsv={isExportingCsv}
          isExportingPdf={isExportingPdf}
          disabled={exportDisabled}
        />
      </div>
    </div>
  );
}
