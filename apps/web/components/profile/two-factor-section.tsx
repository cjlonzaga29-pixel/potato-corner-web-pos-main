'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import {
  use2FAStatus,
  useEnroll2FA,
  useConfirm2FA,
  useDisable2FA,
  useRegenerateBackupCodes,
} from '@/hooks/queries/use-2fa';

function downloadBackupCodes(codes: string[]): void {
  const blob = new Blob([codes.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'potato-corner-backup-codes.txt';
  link.click();
  URL.revokeObjectURL(url);
}

function BackupCodesList({ codes }: { codes: string[] }) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-destructive">
        Save these codes now. They will not be shown again.
      </p>
      <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted p-3 font-mono text-sm">
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => downloadBackupCodes(codes)}>
          Download as .txt
        </Button>
        <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(codes.join('\n'))}>
          Copy to clipboard
        </Button>
      </div>
    </div>
  );
}

function EnrollDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const enroll = useEnroll2FA();
  const confirm = useConfirm2FA();
  const [step, setStep] = useState<'setup' | 'codes'>('setup');
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  function handleOpenChange(next: boolean) {
    if (next && !enroll.data) {
      void enroll.mutateAsync();
    }
    if (!next) {
      setStep('setup');
      setCode('');
      setBackupCodes([]);
      setSaved(false);
    }
    onOpenChange(next);
  }

  async function handleVerify() {
    const result = await confirm.mutateAsync(code);
    setBackupCodes(result.backupCodes);
    setStep('codes');
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        {step === 'setup' && (
          <>
            <DialogHeader>
              <DialogTitle>Set up Two-Factor Authentication</DialogTitle>
              <DialogDescription>
                Scan this with Google Authenticator, Authy, 1Password, or similar app
              </DialogDescription>
            </DialogHeader>
            {enroll.isPending && <Skeleton className="mx-auto h-40 w-40" />}
            {enroll.data && (
              <div className="space-y-4">
                <img src={enroll.data.qrCodeDataUrl} alt="2FA QR code" className="mx-auto h-40 w-40" />
                <div className="space-y-1">
                  <Label>Or enter this code manually</Label>
                  <p className="rounded-md border bg-muted p-2 text-center font-mono text-sm">{enroll.data.secret}</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="totp-verify-code">Enter the 6-digit code from your app</Label>
                  <Input
                    id="totp-verify-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    maxLength={6}
                    placeholder="123456"
                  />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button disabled={code.length < 6 || confirm.isPending} onClick={() => void handleVerify()}>
                Verify
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'codes' && (
          <>
            <DialogHeader>
              <DialogTitle>Save your backup codes</DialogTitle>
              <DialogDescription>Use one of these if you lose access to your authenticator app.</DialogDescription>
            </DialogHeader>
            <BackupCodesList codes={backupCodes} />
            <div className="flex items-center gap-2">
              <Checkbox id="saved-codes" checked={saved} onCheckedChange={(checked) => setSaved(checked === true)} />
              <Label htmlFor="saved-codes">I have saved my codes</Label>
            </div>
            <DialogFooter>
              <Button disabled={!saved} onClick={() => handleOpenChange(false)}>
                Finish
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DisableDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const disable = useDisable2FA();
  const [currentPassword, setCurrentPassword] = useState('');
  const [token, setToken] = useState('');

  async function handleDisable() {
    await disable.mutateAsync({ currentPassword, token });
    setCurrentPassword('');
    setToken('');
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disable Two-Factor Authentication</DialogTitle>
          <DialogDescription>
            Confirm your password and a current authentication code to disable 2FA.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="disable-password">Current password</Label>
            <Input
              id="disable-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="disable-token">Authentication or backup code</Label>
            <Input id="disable-token" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            disabled={!currentPassword || !token || disable.isPending}
            onClick={() => void handleDisable()}
          >
            Disable 2FA
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RegenerateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const regenerate = useRegenerateBackupCodes();
  const [token, setToken] = useState('');

  async function handleRegenerate() {
    await regenerate.mutateAsync(token);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setToken('');
          regenerate.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Regenerate Backup Codes</DialogTitle>
          <DialogDescription>Your old backup codes will stop working immediately.</DialogDescription>
        </DialogHeader>
        {!regenerate.data && (
          <>
            <div className="space-y-1">
              <Label htmlFor="regenerate-token">Enter the 6-digit code from your app</Label>
              <Input id="regenerate-token" value={token} onChange={(e) => setToken(e.target.value)} maxLength={6} />
            </div>
            <DialogFooter>
              <Button disabled={token.length < 6 || regenerate.isPending} onClick={() => void handleRegenerate()}>
                Regenerate
              </Button>
            </DialogFooter>
          </>
        )}
        {regenerate.data && <BackupCodesList codes={regenerate.data.backupCodes} />}
      </DialogContent>
    </Dialog>
  );
}

export function TwoFactorSection() {
  const { data: status, isLoading, isError } = use2FAStatus();
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-Factor Authentication</CardTitle>
        {!isLoading && !isError && !status?.enabled && (
          <CardDescription>Add an extra layer of security to your account.</CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <Skeleton className="h-12 w-full" />}
        {isError && <p className="text-sm text-destructive">Failed to load 2FA status.</p>}

        {!isLoading && !isError && !status?.enabled && (
          <Button onClick={() => setEnrollOpen(true)}>Enable 2FA</Button>
        )}

        {!isLoading && !isError && status?.enabled && (
          <div className="space-y-3">
            <Badge variant="secondary" className="bg-green-100 text-green-800">
              2FA Enabled since {status.enrolledAt ? format(new Date(status.enrolledAt), 'PPP') : '—'}
            </Badge>
            <p className="text-sm text-muted-foreground">
              Backup codes were shown during setup. If lost, regenerate below.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setRegenerateOpen(true)}>
                Regenerate Backup Codes
              </Button>
              <Button variant="destructive" onClick={() => setDisableOpen(true)}>
                Disable 2FA
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <EnrollDialog open={enrollOpen} onOpenChange={setEnrollOpen} />
      <DisableDialog open={disableOpen} onOpenChange={setDisableOpen} />
      <RegenerateDialog open={regenerateOpen} onOpenChange={setRegenerateOpen} />
    </Card>
  );
}
