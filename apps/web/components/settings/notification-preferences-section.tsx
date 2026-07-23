'use client';

import { useEffect, useState } from 'react';
import type { NotificationPreferences } from '@potato-corner/shared';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useNotificationPreferences, useUpdateNotificationPreferences } from '@/hooks/queries/use-settings';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export function NotificationPreferencesSection() {
  const { data, isLoading, isError } = useNotificationPreferences();
  const updatePreferences = useUpdateNotificationPreferences();

  const [form, setForm] = useState<NotificationPreferences | null>(null);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  function handleSave() {
    if (!form) return;
    updatePreferences.mutate(form);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notification Preferences</CardTitle>
        <CardDescription>Choose which alerts and digests you receive.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}

        {isError && <p className="text-sm text-destructive">Failed to load notification preferences.</p>}

        {!isLoading && !isError && form && (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-md border p-3">
              <Label htmlFor="emailDigestEnabled">Email digest</Label>
              <Switch
                id="emailDigestEnabled"
                checked={form.emailDigestEnabled}
                onCheckedChange={(checked) => setForm({ ...form, emailDigestEnabled: checked })}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="emailDigestFrequency">Digest frequency</Label>
              <Select
                value={form.emailDigestFrequency}
                disabled={!form.emailDigestEnabled}
                onValueChange={(value) =>
                  setForm({ ...form, emailDigestFrequency: value as NotificationPreferences['emailDigestFrequency'] })
                }
              >
                <SelectTrigger id="emailDigestFrequency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <Label htmlFor="alertFraud">Fraud alerts</Label>
              <Switch
                id="alertFraud"
                checked={form.alertFraud}
                onCheckedChange={(checked) => setForm({ ...form, alertFraud: checked })}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <Label htmlFor="alertLowStock">Low stock alerts</Label>
              <Switch
                id="alertLowStock"
                checked={form.alertLowStock}
                onCheckedChange={(checked) => setForm({ ...form, alertLowStock: checked })}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <Label htmlFor="alertCashVariance">Cash variance alerts</Label>
              <Switch
                id="alertCashVariance"
                checked={form.alertCashVariance}
                onCheckedChange={(checked) => setForm({ ...form, alertCashVariance: checked })}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <Label htmlFor="alertVoidRequests">Void request alerts</Label>
              <Switch
                id="alertVoidRequests"
                checked={form.alertVoidRequests}
                onCheckedChange={(checked) => setForm({ ...form, alertVoidRequests: checked })}
              />
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <Label htmlFor="dndEnabled">Do not disturb</Label>
              <Switch
                id="dndEnabled"
                checked={form.dndEnabled}
                onCheckedChange={(checked) => setForm({ ...form, dndEnabled: checked })}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="dndStartHour">Start hour</Label>
                <Select
                  value={String(form.dndStartHour)}
                  disabled={!form.dndEnabled}
                  onValueChange={(value) => setForm({ ...form, dndStartHour: Number(value) })}
                >
                  <SelectTrigger id="dndStartHour">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOURS.map((hour) => (
                      <SelectItem key={hour} value={String(hour)}>
                        {String(hour).padStart(2, '0')}:00
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="dndEndHour">End hour</Label>
                <Select
                  value={String(form.dndEndHour)}
                  disabled={!form.dndEnabled}
                  onValueChange={(value) => setForm({ ...form, dndEndHour: Number(value) })}
                >
                  <SelectTrigger id="dndEndHour">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOURS.map((hour) => (
                      <SelectItem key={hour} value={String(hour)}>
                        {String(hour).padStart(2, '0')}:00
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button onClick={handleSave} disabled={updatePreferences.isPending}>
              {updatePreferences.isPending ? 'Saving...' : 'Save changes'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
