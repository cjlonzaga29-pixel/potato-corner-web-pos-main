'use client';

import { useRef } from 'react';
import { Delete } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const KEYPAD_ROWS_1_TO_9 = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

// Height follows the viewport (min 52px touch floor, max 80px) so the pad never pushes the Continue button off a short screen.
const KEY_CLASSES = 'touch-target h-[clamp(3.25rem,9dvh,5rem)] w-full rounded-xl';

interface PinKeypadProps {
  value: string;
  maxLength: number;
  disabled?: boolean;
  onChange: (next: string) => void;
  /** Enter on the physical keyboard, or (future) a dedicated submit key on the on-screen pad — never wired to a plain digit tap, so a fast tap sequence can never accidentally submit. */
  onSubmit: () => void;
  'aria-label'?: string;
}

/**
 * POS-PERF-P32 — shared numeric keypad for PIN entry: masked dots, a
 * touch-sized 0-9 grid, Backspace/Clear, and physical-keyboard passthrough
 * (digits, Backspace, Enter). Deliberately uncontrolled beyond `value` —
 * the parent terminal page still owns the actual PIN string so it can clear
 * it the instant a verify attempt settles (success or failure), same as
 * before this component existed.
 *
 * P46 — keys are full-width cells of a 3-column grid (not fixed 56px
 * circles) sized from the viewport: tall enough to hit reliably on a phone
 * or a counter tablet, capped on desktop, and shrunk on short landscape
 * screens so the whole pad fits without scrolling. The grid's width comes
 * from the parent, so the terminal layout decides how wide the pad is.
 */
export function PinKeypad({ value, maxLength, disabled, onChange, onSubmit, 'aria-label': ariaLabel }: PinKeypadProps) {
  const hiddenInputRef = useRef<HTMLInputElement>(null);

  function appendDigit(digit: string) {
    if (disabled || value.length >= maxLength) return;
    onChange(value + digit);
  }

  function backspace() {
    if (disabled) return;
    onChange(value.slice(0, -1));
  }

  function clear() {
    if (disabled) return;
    onChange('');
  }

  return (
    <div className="flex w-full flex-col items-center gap-4 sm:gap-5">
      {/* Masked dots — the actual PIN is never rendered as text anywhere in this component. A visually-hidden input mirrors the value for screen readers and keeps physical-keyboard entry (digits, Backspace, paste, Enter) working without a visible text field. */}
      <label className="sr-only" htmlFor="pos-pin-hidden-input">
        {ariaLabel ?? 'Staff PIN'}
      </label>
      <input
        id="pos-pin-hidden-input"
        ref={hiddenInputRef}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        placeholder="Enter 4-6 digit PIN"
        maxLength={maxLength}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, maxLength))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit();
          }
        }}
        className="sr-only"
        aria-describedby="pos-pin-dots"
      />
      <div
        id="pos-pin-dots"
        role="status"
        aria-live="off"
        className="flex min-h-6 items-center justify-center gap-3 sm:gap-4"
        onClick={() => hiddenInputRef.current?.focus()}
      >
        {Array.from({ length: maxLength }, (_, i) => (
          <span
            key={i}
            aria-hidden="true"
            className={cn(
              'h-4 w-4 rounded-full border-2 border-input transition-colors sm:h-5 sm:w-5',
              i < value.length ? 'border-primary bg-primary' : 'bg-transparent',
            )}
          />
        ))}
        <span className="sr-only">
          {value.length} of {maxLength} digits entered
        </span>
      </div>

      <div className="grid w-full grid-cols-3 gap-2 sm:gap-3">
        {KEYPAD_ROWS_1_TO_9.map((digit) => (
          <Button
            key={digit}
            type="button"
            variant="outline"
            size="lg"
            className={cn(KEY_CLASSES, 'text-2xl font-semibold')}
            disabled={disabled}
            onClick={() => {
              appendDigit(digit);
              hiddenInputRef.current?.focus();
            }}
            aria-label={`Digit ${digit}`}
          >
            {digit}
          </Button>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="lg"
          className={cn(KEY_CLASSES, 'text-base font-medium text-muted-foreground')}
          disabled={disabled || value.length === 0}
          onClick={clear}
          aria-label="Clear PIN"
        >
          Clear
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className={cn(KEY_CLASSES, 'text-2xl font-semibold')}
          disabled={disabled}
          onClick={() => {
            appendDigit('0');
            hiddenInputRef.current?.focus();
          }}
          aria-label="Digit 0"
        >
          0
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className={KEY_CLASSES}
          disabled={disabled || value.length === 0}
          onClick={() => {
            backspace();
            hiddenInputRef.current?.focus();
          }}
          aria-label="Backspace"
        >
          <Delete className="h-6 w-6" />
        </Button>
      </div>
    </div>
  );
}
