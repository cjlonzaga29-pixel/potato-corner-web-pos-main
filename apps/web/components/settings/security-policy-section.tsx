'use client';

import { useEffect, useState } from 'react';
import type { SecurityPolicy } from '@potato-corner/shared';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAuthStore } from '@/stores/auth.store';
import { useSecurityPolicy, useUpdateSecurityPolicy } from '@/hooks/queries/use-settings';

export function SecurityPolicySection() {
  const isAdmin = useAuthStore((s) => s.isAdmin());
  const { data, isLoading, isError } = useSecurityPolicy();
  const updatePolicy = useUpdateSecurityPolicy();

  const [form, setForm] = useState<SecurityPolicy | null>(null);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  function handleSave() {
    if (!form) return;
    updatePolicy.mutate(form);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Security Policies</CardTitle>
        <CardDescription>Session, password, 2FA, and account lockout rules for all users.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}

        {isError && <p className="text-sm text-destructive">Failed to load security policy.</p>}

        {!isLoading && !isError && form && (
          <>
            <Alert>
              <AlertDescription>Changes take effect on next login for affected users.</AlertDescription>
            </Alert>

            {!isAdmin ? (
              <div className="space-y-3 text-sm">
                <ReadOnlyRow label="Session timeout (minutes)" value={form.sessionTimeoutMinutes} />
                <ReadOnlyRow label="Password minimum length" value={form.passwordMinLength} />
                <ReadOnlyRow label="Require password complexity" value={form.requirePasswordComplexity ? 'Yes' : 'No'} />
                <ReadOnlyRow label="Require 2FA for admins" value={form.require2faForAdmins ? 'Yes' : 'No'} />
                <ReadOnlyRow label="Require 2FA for supervisors" value={form.require2faForSupervisors ? 'Yes' : 'No'} />
                <ReadOnlyRow label="Max failed login attempts" value={form.maxFailedLoginAttempts} />
                <ReadOnlyRow label="Lockout duration (minutes)" value={form.lockoutDurationMinutes} />
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="sessionTimeoutMinutes">Session timeout (minutes)</Label>
                  <Input
                    id="sessionTimeoutMinutes"
                    type="number"
                    min={5}
                    max={1440}
                    value={form.sessionTimeoutMinutes}
                    onChange={(e) => setForm({ ...form, sessionTimeoutMinutes: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="passwordMinLength">Password minimum length</Label>
                  <Input
                    id="passwordMinLength"
                    type="number"
                    min={8}
                    max={64}
                    value={form.passwordMinLength}
                    onChange={(e) => setForm({ ...form, passwordMinLength: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="maxFailedLoginAttempts">Max failed login attempts</Label>
                  <Input
                    id="maxFailedLoginAttempts"
                    type="number"
                    min={3}
                    max={20}
                    value={form.maxFailedLoginAttempts}
                    onChange={(e) => setForm({ ...form, maxFailedLoginAttempts: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="lockoutDurationMinutes">Lockout duration (minutes)</Label>
                  <Input
                    id="lockoutDurationMinutes"
                    type="number"
                    min={1}
                    max={1440}
                    value={form.lockoutDurationMinutes}
                    onChange={(e) => setForm({ ...form, lockoutDurationMinutes: Number(e.target.value) })}
                  />
                </div>

                <div className="flex items-center justify-between rounded-md border p-3 md:col-span-2">
                  <Label htmlFor="requirePasswordComplexity">Require password complexity</Label>
                  <Switch
                    id="requirePasswordComplexity"
                    checked={form.requirePasswordComplexity}
                    onCheckedChange={(checked) => setForm({ ...form, requirePasswordComplexity: checked })}
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border p-3 md:col-span-2">
                  <Label htmlFor="require2faForAdmins">Require 2FA for admins</Label>
                  <Switch
                    id="require2faForAdmins"
                    checked={form.require2faForAdmins}
                    onCheckedChange={(checked) => setForm({ ...form, require2faForAdmins: checked })}
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border p-3 md:col-span-2">
                  <Label htmlFor="require2faForSupervisors">Require 2FA for supervisors</Label>
                  <Switch
                    id="require2faForSupervisors"
                    checked={form.require2faForSupervisors}
                    onCheckedChange={(checked) => setForm({ ...form, require2faForSupervisors: checked })}
                  />
                </div>

                <Button onClick={handleSave} disabled={updatePolicy.isPending} className="md:col-span-2 md:w-fit">
                  {updatePolicy.isPending ? 'Saving...' : 'Save changes'}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ReadOnlyRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between rounded-md border p-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
