'use client';

import { ReportsView } from '@/components/branch-ops/reports-view';
import { ReportsSectionTabs } from '@/components/reports/reports-section-tabs';

export default function SupervisorReportsPage() {
  return (
    <div className="space-y-4">
      <ReportsSectionTabs basePath="/supervisor/reports" />
      <ReportsView />
    </div>
  );
}
