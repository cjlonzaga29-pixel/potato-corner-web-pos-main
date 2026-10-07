import { describe, it, expect } from 'vitest';
import { describeCashierFailure, CONNECTION_UNCERTAIN, STILL_PROCESSING, NOT_SAVED_SAFE_TO_RETRY } from './cashier-error-messages';

describe('describeCashierFailure', () => {
  it('maps INSUFFICIENT_STOCK to "Not enough stock" and passes the server detail through unchanged', () => {
    const result = describeCashierFailure('INSUFFICIENT_STOCK', 'Insufficient stock for Fries: need 5, have 2 available');
    expect(result.title).toBe('Not enough stock');
    expect(result.detail).toBe('Insufficient stock for Fries: need 5, have 2 available');
  });

  it('maps a network-proving-nothing server code to the connection-problem title', () => {
    expect(describeCashierFailure('NETWORK_ERROR', 'fetch failed').title).toBe('Connection problem — checking order status');
    expect(describeCashierFailure('CHECKOUT_ATTEMPT_IN_PROGRESS', 'contended').title).toBe('Connection problem — checking order status');
  });

  it('maps the synthetic uncertain-outcome codes without inventing a "not saved" claim', () => {
    const uncertain = describeCashierFailure(CONNECTION_UNCERTAIN, 'Could not confirm whether this went through.');
    expect(uncertain.title).toBe('Connection problem — checking order status');

    const processing = describeCashierFailure(STILL_PROCESSING, 'Still being processed on the server.');
    expect(processing.title).not.toMatch(/not saved/i);

    const notSaved = describeCashierFailure(NOT_SAVED_SAFE_TO_RETRY, 'Confirmed not charged. Safe to retry.');
    expect(notSaved.title).toBe('Not saved — safe to retry');
  });

  it('maps other known definite-failure codes to clear, specific wording', () => {
    expect(describeCashierFailure('SHIFT_CLOSED', 'Shift is closed').title).toBe('Shift closed');
    expect(describeCashierFailure('PAYMENT_PROOF_REQUIRED', 'Proof required').title).toBe('Payment proof required');
  });

  it('never guesses a specific title for an unrecognized or missing code', () => {
    expect(describeCashierFailure('SOME_FUTURE_CODE', 'detail').title).toBe("Couldn't save sale");
    expect(describeCashierFailure(null, 'detail').title).toBe("Couldn't save sale");
    expect(describeCashierFailure(undefined, 'detail').title).toBe("Couldn't save sale");
  });

  it('never alters the detail message — only ever adds a title on top', () => {
    const detail = 'Exact detail string from the server or an earlier audited local message.';
    expect(describeCashierFailure('INSUFFICIENT_STOCK', detail).detail).toBe(detail);
    expect(describeCashierFailure(null, detail).detail).toBe(detail);
  });
});
