'use client';

import { useState, type MouseEvent, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingSpinner } from './feedback/loading-spinner';
import { cn } from '@/lib/utils';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'danger';
  /**
   * When set, the confirm button stays disabled until the user types this
   * exact (case-sensitive) string — required for true permanent-delete
   * actions (P3D-P3) so a stray click can't destroy data.
   */
  requireTypedConfirmation?: string;
}

/** Used for all destructive action confirmations throughout the application. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  requireTypedConfirmation,
}: ConfirmDialogProps) {
  const [isConfirming, setIsConfirming] = useState(false);
  const [typedValue, setTypedValue] = useState('');
  const canConfirm = !requireTypedConfirmation || typedValue === requireTypedConfirmation;

  // Radix's AlertDialogAction closes the dialog automatically on click —
  // preventDefault suppresses that so the dialog stays open with a
  // loading spinner until the async onConfirm settles.
  async function handleConfirm(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (!canConfirm) return;
    setIsConfirming(true);
    try {
      await onConfirm();
      setTypedValue('');
      onOpenChange(false);
    } finally {
      setIsConfirming(false);
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (isConfirming) return;
    if (!nextOpen) setTypedValue('');
    onOpenChange(nextOpen);
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {requireTypedConfirmation && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Type <span className="font-mono font-semibold text-foreground">{requireTypedConfirmation}</span> to confirm.
            </p>
            <Input
              value={typedValue}
              onChange={(event) => setTypedValue(event.target.value)}
              disabled={isConfirming}
              autoComplete="off"
              autoFocus
              aria-label={`Type ${requireTypedConfirmation} to confirm`}
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} disabled={isConfirming}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isConfirming || !canConfirm}
            className={cn(variant === 'danger' && buttonVariants({ variant: 'danger' }))}
          >
            {isConfirming ? <LoadingSpinner size="sm" className="text-current" /> : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
