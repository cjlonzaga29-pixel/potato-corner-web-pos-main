'use client';

import { useState } from 'react';
import { Eye, EyeOff, ShieldAlert } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CopyButton } from '@/components/shared/copy-button';
import { useResetEmployeePassword } from '@/hooks/queries/use-employees';
import type { BranchAccountOverview } from '@/hooks/queries/use-branches';

const PASSWORD_RULES =
  'At least 8 characters, with an uppercase letter, a lowercase letter, a number, and a special character.';

interface ResetBranchPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: BranchAccountOverview;
}

/**
 * Admin-triggered branch account password reset. Two modes: system-generated
 * (default) or admin-supplied. Either way, once a temporary password is
 * server-generated it is shown exactly once here — closing the dialog
 * discards it from memory, and it's never persisted in plaintext or
 * retrievable again afterward.
 */
export function ResetBranchPasswordDialog({ open, onOpenChange, account }: ResetBranchPasswordDialogProps) {
  const [mode, setMode] = useState<'generate' | 'custom'>('generate');
  const [customPassword, setCustomPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const resetPassword = useResetEmployeePassword(account.user_id);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setMode('generate');
      setCustomPassword('');
      setRevealed(false);
      setResult(null);
      resetPassword.reset();
    }
    onOpenChange(next);
  }

  function handleSubmit() {
    resetPassword.mutate(
      { new_password: mode === 'custom' ? customPassword : undefined },
      {
        onSuccess: (data) => {
          if (data.temporary_password) {
            setResult(data.temporary_password);
            setRevealed(false);
          } else {
            handleOpenChange(false);
          }
        },
      },
    );
  }

  const showResult = result !== null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="select-none sm:max-w-md" onCopy={(event) => showResult && event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Reset Password</DialogTitle>
          <DialogDescription>
            {account.branch_name} — {account.email}
          </DialogDescription>
        </DialogHeader>

        {showResult ? (
          <>
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>This password will only be shown once. It cannot be retrieved again after you close this dialog.</span>
            </div>
            <div className="flex items-center justify-between gap-2 rounded-md border p-3">
              <p className="font-mono text-sm">{revealed ? result : '•'.repeat(result.length)}</p>
              <div className="flex items-center gap-1">
                <Button type="button" variant="ghost" size="icon" onClick={() => setRevealed((prev) => !prev)}>
                  {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <CopyButton value={result} label="Copy temporary password" />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <Tabs value={mode} onValueChange={(value) => setMode(value as 'generate' | 'custom')}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="generate">Generate secure password</TabsTrigger>
                <TabsTrigger value="custom">Enter custom password</TabsTrigger>
              </TabsList>
              <TabsContent value="generate" className="pt-2 text-sm text-muted-foreground">
                A secure temporary password will be generated and shown once. The branch account must change it on
                next login.
              </TabsContent>
              <TabsContent value="custom" className="space-y-2 pt-2">
                <Input
                  type="password"
                  placeholder="New password"
                  value={customPassword}
                  onChange={(event) => setCustomPassword(event.target.value)}
                  autoComplete="new-password"
                />
                <p className="text-xs text-muted-foreground">{PASSWORD_RULES}</p>
              </TabsContent>
            </Tabs>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleSubmit}
                disabled={resetPassword.isPending || (mode === 'custom' && customPassword.length < 8)}
              >
                {resetPassword.isPending ? 'Resetting...' : 'Reset Password'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
