'use client';

import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ReportsView } from '@/components/branch-ops/reports-view';
import { ExpensesView } from '@/components/branch-ops/expenses-view';
import BranchAnalyticsPage from '@/app/(branch)/branch/analytics/page';
import BranchActivityLogsPage from '@/app/(branch)/branch/activity-logs/page';

/**
 * Single Branch sidebar "Reports" entry — Expenses, Analytics, and Activity
 * Logs are consolidated here as tabs instead of separate top-level sidebar
 * items. Each tab reuses its existing self-contained view exactly as it
 * rendered on its own page; nothing about their data or behavior changed,
 * only where they're reached from. Kept as an outer tab layer around
 * ReportsView (rather than folded into it) because ReportsView is shared
 * with /supervisor/reports, and these three views resolve their branch from
 * the branch role's own JWT — not the supervisor's branch selector.
 */
export default function BranchReportsPage() {
  const [section, setSection] = useState('core');

  return (
    <Tabs value={section} onValueChange={setSection} className="space-y-4">
      <TabsList className="flex-wrap h-auto">
        <TabsTrigger value="core">Sales &amp; Operations</TabsTrigger>
        <TabsTrigger value="expenses">Expenses</TabsTrigger>
        <TabsTrigger value="analytics">Analytics</TabsTrigger>
        <TabsTrigger value="activity-logs">Activity Logs</TabsTrigger>
      </TabsList>

      <TabsContent value="core">
        <ReportsView />
      </TabsContent>
      <TabsContent value="expenses">
        <ExpensesView />
      </TabsContent>
      <TabsContent value="analytics">
        <BranchAnalyticsPage />
      </TabsContent>
      <TabsContent value="activity-logs">
        <BranchActivityLogsPage />
      </TabsContent>
    </Tabs>
  );
}
