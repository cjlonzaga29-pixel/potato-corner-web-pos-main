import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PinKeypad } from './pin-keypad';

afterEach(() => cleanup());

/** Controlled harness — mirrors how terminal/page.tsx actually wires value/onChange. */
function Harness({ maxLength = 6, disabled = false, onSubmit = vi.fn() }: { maxLength?: number; disabled?: boolean; onSubmit?: () => void }) {
  const [value, setValue] = useState('');
  return <PinKeypad value={value} maxLength={maxLength} disabled={disabled} onChange={setValue} onSubmit={onSubmit} />;
}

function dotsContainer() {
  return document.getElementById('pos-pin-dots') as HTMLElement;
}

function filledDotCount() {
  return dotsContainer().querySelectorAll('span.bg-primary').length;
}

describe('PinKeypad', () => {
  it('tapping digits fills the masked dots and the hidden input, preserving leading zeros', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Digit 0' }));
    fireEvent.click(screen.getByRole('button', { name: 'Digit 0' }));
    fireEvent.click(screen.getByRole('button', { name: 'Digit 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Digit 2' }));

    expect(filledDotCount()).toBe(4);
    expect(screen.getByLabelText('Staff PIN')).toHaveValue('0012');
  });

  it('never renders the PIN as plain text — the hidden input is masked and dots carry no digit text', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Digit 7' }));

    expect(screen.getByLabelText('Staff PIN')).toHaveAttribute('type', 'password');
    expect(dotsContainer().textContent).not.toContain('7');
  });

  it('stops accepting digits once maxLength is reached', () => {
    render(<Harness maxLength={4} />);
    for (const digit of ['1', '2', '3', '4', '5']) {
      fireEvent.click(screen.getByRole('button', { name: `Digit ${digit}` }));
    }
    expect(screen.getByLabelText('Staff PIN')).toHaveValue('1234');
    expect(filledDotCount()).toBe(4);
  });

  it('Backspace removes the last digit and Clear empties the PIN', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Digit 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Digit 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Digit 3' }));

    fireEvent.click(screen.getByRole('button', { name: 'Backspace' }));
    expect(screen.getByLabelText('Staff PIN')).toHaveValue('12');

    fireEvent.click(screen.getByRole('button', { name: 'Clear PIN' }));
    expect(screen.getByLabelText('Staff PIN')).toHaveValue('');
  });

  it('Backspace and Clear are disabled while the PIN is already empty', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Backspace' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear PIN' })).toBeDisabled();
  });

  it('typing digits on a physical keyboard strips non-numeric characters', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Staff PIN'), { target: { value: '12a3b4' } });
    expect(screen.getByLabelText('Staff PIN')).toHaveValue('1234');
  });

  it('pasting a value longer than maxLength is truncated, never overflowing the dots', () => {
    render(<Harness maxLength={6} />);
    fireEvent.change(screen.getByLabelText('Staff PIN'), { target: { value: '123456789' } });
    expect(screen.getByLabelText('Staff PIN')).toHaveValue('123456');
    expect(filledDotCount()).toBe(6);
  });

  it('Enter on the physical keyboard submits, but digit taps never do', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Digit 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Digit 2' }));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByLabelText('Staff PIN'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('disabled blocks every digit, Backspace, and Clear interaction', () => {
    render(<Harness disabled />);
    expect(screen.getByLabelText('Staff PIN')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Digit 1' }));
    expect(screen.getByLabelText('Staff PIN')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Backspace' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear PIN' })).toBeDisabled();
  });
});
