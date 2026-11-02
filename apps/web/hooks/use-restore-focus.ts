import { useRef } from 'react';

/**
 * POS-PERF-P58 — Radix returns focus only to a DialogTrigger on close. A dialog
 * opened from page state has none, so keyboard users land on <body>. Remembers
 * what had focus as the dialog opens; pass the result to DialogContent's
 * onCloseAutoFocus.
 */
export function useRestoreFocus(open = true) {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== 'undefined') opener.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;
  return () => {
    if (opener.current?.isConnected) opener.current.focus();
  };
}
