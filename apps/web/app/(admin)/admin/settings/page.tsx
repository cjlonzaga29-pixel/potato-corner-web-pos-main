'use client';

import { Suspense } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { NotificationPreferencesSection } from '@/components/settings/notification-preferences-section';
import { DiscountSettingsSection } from '@/components/settings/discount-settings-section';
import { WorkHoursSettingsSection } from '@/components/settings/work-hours-settings-section';
import { WriteGateSettingsSection } from '@/components/settings/write-gate-settings-section';

const TABS = ['notifications', 'discounts', 'work-hours', 'write-gate'] as const;
type TabValue = (typeof TABS)[number];
const DEFAULT_TAB: TabValue = 'notifications';

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
    <div className="app-section app-section-gap">
      <div>
        <h1 className="text-xl font-semibold">System Settings</h1>
        <p className="text-muted-foreground text-sm">Notification, discount, and work hours configuration.</p>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="discounts">Discount Settings</TabsTrigger>
          <TabsTrigger value="work-hours">Work Hours</TabsTrigger>
          <TabsTrigger value="write-gate">Write Gate</TabsTrigger>
        </TabsList>

        <TabsContent value="notifications">
          <NotificationPreferencesSection />
        </TabsContent>

        <TabsContent value="discounts">
          <DiscountSettingsSection />
        </TabsContent>

        <TabsContent value="work-hours">
          <WorkHoursSettingsSection />
        </TabsContent>

        <TabsContent value="write-gate">
          <WriteGateSettingsSection />
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
