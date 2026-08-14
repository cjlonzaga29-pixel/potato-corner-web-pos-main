'use client';

import { Loader2, Download, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ExportButtonsProps {
  onExportCsv: () => void;
  onExportPdf: () => void;
  isExportingCsv: boolean;
  isExportingPdf: boolean;
  /** Disables both buttons without affecting the exporting spinner/label state — e.g. a report that requires a branch selection. */
  disabled?: boolean;
  className?: string;
}

/**
 * Shared Export CSV / Export PDF button pair — one implementation so every
 * report screen (Admin's ReportFilterBar, Supervisor/Branch's ReportsView)
 * gets the same icons, loading state, and mobile-responsive sizing instead
 * of each screen re-implementing its own button markup.
 */
export function ExportButtons({ onExportCsv, onExportPdf, isExportingCsv, isExportingPdf, disabled = false, className }: ExportButtonsProps) {
  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={onExportCsv}
        disabled={isExportingCsv || disabled}
        className={cn('w-full sm:w-auto', className)}
      >
        {isExportingCsv ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="mr-2 h-4 w-4" aria-hidden="true" />}
        {isExportingCsv ? 'Exporting CSV…' : 'Export CSV'}
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={onExportPdf}
        disabled={isExportingPdf || disabled}
        className={cn('w-full sm:w-auto', className)}
      >
        {isExportingPdf ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <FileText className="mr-2 h-4 w-4" aria-hidden="true" />}
        {isExportingPdf ? 'Exporting PDF…' : 'Export PDF'}
      </Button>
    </>
  );
}
