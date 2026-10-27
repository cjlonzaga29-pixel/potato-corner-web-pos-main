'use client';

import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

interface FormSaveErrorProps {
  error: Error | null;
  /** Replaces the default "try again" guidance, e.g. a conflict's Load latest action. */
  children?: ReactNode;
}

/**
 * POS-PERF-P41 — a failed save shown inside the form that attempted it, with
 * everything typed still in place, instead of only a toast that disappears.
 */
export function FormSaveError({ error, children }: FormSaveErrorProps) {
  if (!error) return null;
  return (
    <Alert variant="destructive" data-testid="form-save-error">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Not saved</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{error.message}</p>
        {children ?? <p>Your entries are still here — correct them and save again, or Cancel.</p>}
      </AlertDescription>
    </Alert>
  );
}
