'use client';

import { Suspense } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { SecurityPolicySection } from '@/components/settings/security-policy-section';
import { NotificationPreferencesSection } from '@/components/settings/notification-preferences-section';
import { ReceiptTemplatesSection } from '@/components/settings/receipt-templates-section';

const TABS = ['security', 'notifications', 'receipts'] as const;
type TabValue = (typeof TABS)[number];
const DEFAULT_TAB: TabValue = 'security';

function isTabValue(value: string | null): value is TabValue {
  return TABS.includes(value as TabValue);
}

function SettingsPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tabParam = searchParams.get('tab');
  const activeTab: TabValue = isTabValue(tabParam) ? tabParam : DEFAULT_TAB;

  function handleTabChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', value);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">System Settings</h1>
        <p className="text-muted-foreground text-sm">Security, notification, and receipt configuration.</p>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="receipts">Receipt Templates</TabsTrigger>
        </TabsList>

        <TabsContent value="security">
          <SecurityPolicySection />
        </TabsContent>

        <TabsContent value="notifications">
          <NotificationPreferencesSection />
        </TabsContent>

        <TabsContent value="receipts">
          <ReceiptTemplatesSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div>Loading settings...</div>}>
      <SettingsPageContent />
    </Suspense>
  );
}
