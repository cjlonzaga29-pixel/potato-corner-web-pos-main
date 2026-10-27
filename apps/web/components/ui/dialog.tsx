'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowLeft, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * POS-PERF-P39 — a region inside a dialog (the supervisor product editor)
 * that hosts the dialogs its own children open — Add Size, recipe lines,
 * flavors, Mix & Max slots, option groups, confirmations — as panels over
 * that region instead of a second modal stacked on the first. A hosted
 * dialog is non-modal: no second overlay or focus trap (the host's own modal
 * dialog already traps focus), Escape closes only the top panel, clicks
 * elsewhere in the host never dismiss it, and focus returns to the control
 * that opened it. Outside a host every dialog is unchanged.
 *
 * POS-PERF-P41 — a hosted dialog is laid out as an inline section of the
 * host, not a small dialog inside it: full width with the host's own
 * padding (a caller's dialog sizing classes are ignored), a "Back to …"
 * button in place of the corner X, a left-aligned heading and the actions
 * right-aligned under a divider. It is a labelled region, not a second
 * dialog. Back and Escape ask before discarding anything the form reports
 * as typed (DialogContent's hasUnsavedInput).
 */
interface DialogHostValue {
  container: HTMLElement | null;
  topId: string | null;
  register: (id: string) => () => void;
  backLabel: string;
  /** Open panels, bottom first — a panel opened from another one goes back to it, not to the host. */
  stack: readonly string[];
}

const DialogHostContext = React.createContext<DialogHostValue | null>(null);

interface DialogHostProps {
  /** The positioned element hosted panels render into; each panel fills it. */
  container: HTMLElement | null;
  /** Called with whether any hosted panel is open, e.g. to make the content underneath inert. */
  onActiveChange?: (active: boolean) => void;
  /** POS-PERF-P41 — what a hosted section's back button says, e.g. "Back to Sizes & Prices". */
  backLabel?: string;
  children: React.ReactNode;
}

function DialogHost({ container, onActiveChange, backLabel = 'Back', children }: DialogHostProps) {
  const [stack, setStack] = React.useState<string[]>([]);
  const register = React.useCallback((id: string) => {
    setStack((current) => [...current, id]);
    return () => setStack((current) => current.filter((entry) => entry !== id));
  }, []);
  const active = stack.length > 0;
  React.useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);
  const value = React.useMemo(() => ({ container, topId: stack.at(-1) ?? null, register, backLabel, stack }), [container, stack, register, backLabel]);
  return <DialogHostContext.Provider value={value}>{children}</DialogHostContext.Provider>;
}

/** True inside a DialogHost — for components (like ConfirmDialog) built on another primitive that must switch to this one when hosted. */
function useIsDialogHosted(): boolean {
  return React.useContext(DialogHostContext) !== null;
}

/** POS-PERF-P41 — true inside a hosted section's content, so its header and footer take the section layout. */
const HostedSectionContext = React.createContext(false);

function Dialog({ modal, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const host = React.useContext(DialogHostContext);
  return <DialogPrimitive.Root modal={host ? false : modal} {...props} />;
}
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-black/50 print:hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0', className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Defaults to true (every existing dialog in the app keeps its close X unchanged). Set false for a dialog that must never offer an incidental dismiss — e.g. the POS sale-status popup, which instead gives explicit Retry/New Sale actions so a sale in flight can never be "closed" into a stuck or ambiguous state. */
  showCloseButton?: boolean;
  /**
   * POS-PERF-P41 — the form holds typed, unsaved values. Hosted in the product editor, Back and Escape then ask before
   * discarding them. Ignored by a standalone dialog. A prop rather than context: the component that owns the form state
   * is the one rendering this dialog, outside anything this content provides.
   */
  hasUnsavedInput?: boolean;
}

function DialogCloseButton({ label = 'Close' }: { label?: string }) {
  return (
    <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none print:hidden">
      <X className="h-4 w-4" />
      <span className="sr-only">{label}</span>
    </DialogPrimitive.Close>
  );
}

const HOSTED_BACK_BUTTON_CLASSES =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** Mounted only while its dialog is open (the Portal's presence gates it), so the host's stack is exactly what is shown. */
function HostedPanel({ host, children }: { host: DialogHostValue; children: (opener: HTMLElement | null, nested: boolean) => React.ReactNode }) {
  const id = React.useId();
  // Read during the first render, before Radix moves focus into the panel.
  const [opener] = React.useState(() => (typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)));
  const { register } = host;
  React.useEffect(() => register(id), [register, id]);
  return (
    <div className="pointer-events-auto absolute inset-0 overflow-y-auto bg-card" inert={host.topId !== id} data-hosted-dialog="">
      {children(opener, host.stack.indexOf(id) > 0)}
    </div>
  );
}

const HostedDialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps & { host: DialogHostValue }>(
  // className and showCloseButton size and dress a standalone dialog; a hosted section always takes the host's width and offers Back instead.
  (
    { host, className: _className, children, showCloseButton: _showCloseButton, hasUnsavedInput: dirty = false, onInteractOutside, onCloseAutoFocus, onEscapeKeyDown, role, ...props },
    ref,
  ) => {
    const [confirmingBack, setConfirmingBack] = React.useState(false);
    if (!host.container) return null;
    return (
      <DialogPortal container={host.container}>
        <HostedPanel host={host}>
          {(opener, nested) => (
            <DialogPrimitive.Content
              ref={ref}
              role={role ?? 'region'}
              data-hosted-section=""
              className="relative w-full space-y-4 px-4 py-4 outline-none sm:px-6"
              onInteractOutside={(event) => {
                onInteractOutside?.(event);
                // A click on the host's header or tabs never discards what was typed here.
                event.preventDefault();
              }}
              onEscapeKeyDown={(event) => {
                onEscapeKeyDown?.(event);
                if (event.defaultPrevented || !dirty) return;
                event.preventDefault();
                setConfirmingBack(true);
              }}
              onCloseAutoFocus={(event) => {
                onCloseAutoFocus?.(event);
                if (event.defaultPrevented) return;
                event.preventDefault();
                // Once the host has re-rendered without this panel and made the content underneath interactive again
                // (an inert ancestor refuses focus, so retry for a few frames).
                let attempts = 0;
                const restore = () => {
                  if (!opener?.isConnected) return;
                  opener.focus();
                  if (document.activeElement !== opener && ++attempts < 5) requestAnimationFrame(restore);
                };
                requestAnimationFrame(restore);
              }}
              {...props}
            >
              {confirmingBack ? (
                <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  <span className="mr-auto">Discard what you typed in this form?</span>
                  <button type="button" className={HOSTED_BACK_BUTTON_CLASSES} onClick={() => setConfirmingBack(false)} autoFocus>
                    Keep editing
                  </button>
                  <DialogPrimitive.Close className={cn(HOSTED_BACK_BUTTON_CLASSES, 'border-destructive text-destructive')}>Discard and go back</DialogPrimitive.Close>
                </div>
              ) : dirty ? (
                <button type="button" className={HOSTED_BACK_BUTTON_CLASSES} onClick={() => setConfirmingBack(true)}>
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  {nested ? 'Back to the previous form' : host.backLabel}
                </button>
              ) : (
                <DialogPrimitive.Close className={HOSTED_BACK_BUTTON_CLASSES}>
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  {nested ? 'Back to the previous form' : host.backLabel}
                </DialogPrimitive.Close>
              )}
              <HostedSectionContext.Provider value>{children}</HostedSectionContext.Provider>
            </DialogPrimitive.Content>
          )}
        </HostedPanel>
      </DialogPortal>
    );
  },
);
HostedDialogContent.displayName = 'HostedDialogContent';

const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  ({ className, children, showCloseButton = true, hasUnsavedInput, ...props }, ref) => {
    const host = React.useContext(DialogHostContext);
    if (host) {
      return (
        <HostedDialogContent ref={ref} host={host} className={className} showCloseButton={showCloseButton} hasUnsavedInput={hasUnsavedInput} {...props}>
          {children}
        </HostedDialogContent>
      );
    }
    return (
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          ref={ref}
          className={cn(
            // print:* here matters beyond just this component: any dialog that contains a
            // #receipt-print-area (see globals.css) relies on this fixed/transformed/clipped
            // box being neutralized for print, otherwise the printable content collapses to
            // a blank/near-zero box even though it's marked visible.
            'app-dialog-padding fixed left-[50%] top-[50%] z-50 grid max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-xl border border-border/60 bg-card shadow-2xl shadow-black/10 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 dark:shadow-black/50 print:static print:left-0 print:top-0 print:z-auto print:h-auto print:max-h-none print:w-auto print:max-w-none print:translate-x-0 print:translate-y-0 print:overflow-visible print:rounded-none print:border-none print:bg-transparent print:p-0 print:shadow-none',
            className,
          )}
          {...props}
        >
          {children}
          {showCloseButton && <DialogCloseButton />}
        </DialogPrimitive.Content>
      </DialogPortal>
    );
  },
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => {
  const hosted = React.useContext(HostedSectionContext);
  return <div className={cn(hosted ? 'flex flex-col space-y-1 text-left' : 'flex flex-col space-y-1.5 text-center sm:text-left', !hosted && className)} {...props} />;
};
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => {
  // POS-PERF-P41 — hosted, the actions sit where every editor section keeps them: right-aligned under a divider.
  const hosted = React.useContext(HostedSectionContext);
  return (
    <div
      className={cn(hosted ? 'flex flex-wrap items-center justify-end gap-2 border-t pt-4' : 'flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', !hosted && className)}
      {...props}
    />
  );
};
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogHost,
  useIsDialogHosted,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
