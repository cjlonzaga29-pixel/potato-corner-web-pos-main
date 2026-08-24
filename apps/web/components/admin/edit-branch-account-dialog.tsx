'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Form, FormField, FormItem, FormLabel, FormControl, FormDescription, FormMessage } from '@/components/ui/form';
import { FormFieldWrapper } from '@/components/shared/forms/form-field-wrapper';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useUpdateBranchAccountCredentials } from '@/hooks/queries/use-employees';
import type { BranchAccountOverview } from '@/hooks/queries/use-branches';

const PASSWORD_RULES =
  'At least 8 characters, with an uppercase letter, a lowercase letter, a number, and a special character.';
const PASSWORD_COMPLEXITY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/;

const formSchema = z
  .object({
    email: z.email('Must be a valid email'),
    new_password: z
      .string()
      .optional()
      .refine((value) => !value || (value.length >= 8 && PASSWORD_COMPLEXITY.test(value)), { message: PASSWORD_RULES }),
    confirm_password: z.string().optional(),
  })
  .refine((values) => !values.new_password || values.new_password === values.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  });

type FormValues = z.input<typeof formSchema>;

const DEFAULT_PASSWORD_FIELDS = { new_password: '', confirm_password: '' };

interface EditBranchAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: BranchAccountOverview;
}

/**
 * Replaces the old Reset Password flow: Super Admin edits the branch
 * account's email and/or sets a new password directly here. A password set
 * through this dialog is PERMANENT — it does not force a change on next
 * login (see employees.service.ts's updateBranchAccountCredentials). The eye
 * toggle only reveals the password currently typed into this form; the
 * account's existing stored password is never retrievable.
 */
export function EditBranchAccountDialog({ open, onOpenChange, account }: EditBranchAccountDialogProps) {
  const [revealNew, setRevealNew] = useState(false);
  const [revealConfirm, setRevealConfirm] = useState(false);
  const updateCredentials = useUpdateBranchAccountCredentials(account.user_id);
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: account.email, ...DEFAULT_PASSWORD_FIELDS },
  });

  useEffect(() => {
    if (open) form.reset({ email: account.email, ...DEFAULT_PASSWORD_FIELDS });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account.user_id]);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setRevealNew(false);
      setRevealConfirm(false);
    }
    onOpenChange(next);
  }

  async function onSubmit(values: FormValues) {
    const parsed = formSchema.parse(values);
    const payload: { email?: string; new_password?: string } = {};
    if (parsed.email !== account.email) payload.email = parsed.email;
    if (parsed.new_password) payload.new_password = parsed.new_password;

    // Nothing actually changed — close without mutating (cancel-equivalent).
    if (!payload.email && !payload.new_password) {
      handleOpenChange(false);
      return;
    }

    await updateCredentials.mutateAsync(payload);
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Branch Account</DialogTitle>
          <DialogDescription>{account.branch_name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label>Username / Account</Label>
          <Input value={account.email} disabled readOnly />
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormFieldWrapper<FormValues> name="email" label="Email" required>
              <Input type="email" placeholder="branch@email.com" />
            </FormFieldWrapper>

            <FormField
              control={form.control}
              name="new_password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>New Password</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input {...field} type={revealNew ? 'text' : 'password'} autoComplete="new-password" className="pr-10" />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-full px-3"
                        onClick={() => setRevealNew((prev) => !prev)}
                      >
                        {revealNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                  </FormControl>
                  <FormDescription>Leave blank to keep the existing password. {PASSWORD_RULES}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="confirm_password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Confirm Password</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input {...field} type={revealConfirm ? 'text' : 'password'} autoComplete="new-password" className="pr-10" />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-full px-3"
                        onClick={() => setRevealConfirm((prev) => !prev)}
                      >
                        {revealConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateCredentials.isPending}>
                {updateCredentials.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
