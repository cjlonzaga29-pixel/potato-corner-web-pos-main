'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { ROLE_LABELS } from '@potato-corner/shared';
import { useAuth } from '@/hooks/use-auth';
import { useUpdateProfile } from '@/hooks/queries/use-profile';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ActiveSessionsSection } from '@/components/profile/active-sessions-section';
import { TwoFactorSection } from '@/components/profile/two-factor-section';

const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
] as const;

const NAME_MAX_LENGTH = 100;

interface ProfilePageContentProps {
  /** Hides the Active Sessions card. Defaults to shown (Supervisor keeps device management; Super Admin does not). */
  showActiveSessions?: boolean;
}

/**
 * Account Information's Name field is the only editable field on this page
 * — email, role, and branches stay read-only. Split out so the prefill/dirty
 * tracking only ever touches the Name input, not the rest of the card.
 */
function NameField() {
  const { user } = useAuth();
  const updateProfile = useUpdateProfile();
  const originalName = user ? `${user.firstName} ${user.lastName}`.trim() || user.email || '' : '';

  const [name, setName] = useState('');
  const [initialized, setInitialized] = useState(false);

  // Prefill once the authenticated user has loaded — does not re-sync after
  // that so it never clobbers what the user is actively typing.
  useEffect(() => {
    if (!initialized && user) {
      setName(originalName);
      setInitialized(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, initialized]);

  const trimmedName = name.trim();
  const isUnchanged = trimmedName === originalName;
  const isInvalid = trimmedName.length === 0 || trimmedName.length > NAME_MAX_LENGTH;
  const isSaving = updateProfile.isPending;

  async function handleSave() {
    if (isUnchanged || isInvalid || isSaving) return;
    try {
      await updateProfile.mutateAsync(trimmedName);
      setName(trimmedName);
      toast.success('Name updated successfully');
    } catch (error) {
      // Entered value is left as-is (not reset to originalName) so the user can retry without retyping.
      toast.error(error instanceof Error ? error.message : 'Failed to update name');
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="profile-name" className="text-muted-foreground">
          Name
        </Label>
        <Input
          id="profile-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={NAME_MAX_LENGTH}
          disabled={isSaving}
          className="max-w-[240px] text-right font-medium"
        />
      </div>
      <div className="flex justify-end">
        <Button size="sm" disabled={isUnchanged || isInvalid || isSaving} onClick={() => void handleSave()}>
          {isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>
    </div>
  );
}

export function ProfilePageContent({ showActiveSessions = true }: ProfilePageContentProps) {
  const { user } = useAuth();
  const { theme = 'system', setTheme } = useTheme();

  const branchLabel =
    !user?.branchIds || user.branchIds.length === 0 ? 'All Branches' : user.branchIds.join(', ');

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Profile</h1>
        <p className="text-sm text-muted-foreground">Manage your account, security, and preferences.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <NameField />
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

      {showActiveSessions && <ActiveSessionsSection />}

      <TwoFactorSection />

      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>Update the password used to sign in to your account.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild>
            <Link href="/change-password">Change Password</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
