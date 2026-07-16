'use client';

import { Loader2, Download, FileText, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranches } from '@/hooks/queries/use-branches';

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
  isExporting: boolean;
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
  isExporting,
  showBranchSelector,
}: ReportFilterBarProps) {
  // useBranches(filters) takes a single filters argument (no `enabled` gate) — called
  // unconditionally per the rules of hooks; when showBranchSelector is false the fetched
  // list is simply never rendered, which is a cheap, cached, harmless request.
  const { data: branchesData } = useBranches({ limit: 100 });
  const branches = branchesData?.branches ?? [];

  return (
    <div className="flex flex-wrap items-end gap-4">
      {showBranchSelector && (
        <div>
          <Label htmlFor="report-filter-branch">Branch</Label>
          <Select value={branchId ?? 'all'} onValueChange={(value) => onBranchChange(value === 'all' ? null : value)}>
            <SelectTrigger id="report-filter-branch" className="w-[200px]">
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
      <div>
        <Label htmlFor="report-filter-from">From</Label>
        <Input id="report-filter-from" type="date" value={dateFrom} onChange={(e) => onDateFromChange(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="report-filter-to">To</Label>
        <Input id="report-filter-to" type="date" value={dateTo} onChange={(e) => onDateToChange(e.target.value)} />
      </div>
      <Button variant="outline" onClick={onRefresh} disabled={isRefreshDisabled}>
        <RotateCw className="mr-2 h-4 w-4" />
        {isRefreshDisabled ? `Refresh (${refreshCooldownSeconds}s)` : 'Refresh'}
      </Button>
      <Button variant="outline" onClick={onExportCsv} disabled={isExporting}>
        {isExporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
        Export CSV
      </Button>
      <Button variant="outline" onClick={onExportPdf} disabled={isExporting}>
        {isExporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}
        Export PDF
      </Button>
    </div>
  );
}
