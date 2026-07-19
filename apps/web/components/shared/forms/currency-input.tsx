'use client';

import { useEffect, useState, type ChangeEvent, type FocusEvent } from 'react';
import { Input } from '@/components/ui/input';

interface CurrencyInputProps {
  value: number | null | undefined;
  onChange: (value: number) => void;
  onBlur?: () => void;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  name?: string;
  'aria-label'?: string;
}

/** Displays a ₱-prefixed value while editing; always reports a plain number to the caller (React Hook Form), never a formatted string. */
export function CurrencyInput({ value, onChange, onBlur, disabled, placeholder, id, name, 'aria-label': ariaLabel }: CurrencyInputProps) {
  const [displayValue, setDisplayValue] = useState(() => (value != null ? String(value) : ''));

  useEffect(() => {
    setDisplayValue(value != null ? String(value) : '');
  }, [value]);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const digitsAndDot = event.target.value.replace(/[^\d.]/g, '');
    const parts = digitsAndDot.split('.');
    const sanitized = parts.length > 2 ? `${parts[0]}.${parts.slice(1).join('')}` : digitsAndDot;
    setDisplayValue(sanitized);
    const numeric = parseFloat(sanitized);
    onChange(Number.isNaN(numeric) ? 0 : numeric);
  }

  function handleBlur(_event: FocusEvent<HTMLInputElement>) {
    const numeric = parseFloat(displayValue);
    const safe = Number.isNaN(numeric) ? 0 : numeric;
    setDisplayValue(safe.toFixed(2));
    onChange(safe);
    onBlur?.();
  }

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
        ₱
      </span>
      <Input
        id={id}
        name={name}
        aria-label={ariaLabel}
        inputMode="decimal"
        className="pl-7"
        value={displayValue}
        onChange={handleChange}
        onBlur={handleBlur}
        disabled={disabled}
        placeholder={placeholder ?? '0.00'}
      />
    </div>
  );
}
