'use client';

import Link from 'next/link';
import { useTheme } from 'next-themes';
import { ROLE_LABELS } from '@potato-corner/shared';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
] as const;

export function ProfilePageContent() {
  const { user } = useAuth();
  const { theme = 'system', setTheme } = useTheme();

  const branchLabel =
    !user?.branchIds || user.branchIds.length === 0 ? 'All Branches' : user.branchIds.join(', ');

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Profile</h1>

      <Card>
        <CardHeader>
          <CardTitle>Account Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Name</span>
            <span className="font-medium">
              {user ? `${user.firstName} ${user.lastName}`.trim() || user.email : '—'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Email</span>
            <span className="font-medium">{user?.email ?? '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Role</span>
            <span className="font-medium">{user ? ROLE_LABELS[user.role] : '—'}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Branches</span>
            <span className="text-right font-medium">{branchLabel}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2">
          {THEME_OPTIONS.map((option) => (
            <Button
              key={option.value}
              variant={theme === option.value ? 'default' : 'outline'}
              onClick={() => setTheme(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </CardContent>
      </Card>

      <Button variant="outline" asChild>
        <Link href="/change-password">Change Password</Link>
      </Button>
    </div>
  );
}
