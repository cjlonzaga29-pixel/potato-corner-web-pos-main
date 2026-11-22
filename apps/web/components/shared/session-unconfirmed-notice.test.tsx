import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const { mockRetry, mockReplace } = vi.hoisted(() => ({ mockRetry: vi.fn(), mockReplace: vi.fn() }));
vi.mock('@/hooks/use-auth', () => ({ retryUnconfirmedSession: mockRetry }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockReplace, push: vi.fn() }) }));

const { SessionUnconfirmedNotice } = await import('./session-unconfirmed-notice');

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
}

beforeEach(() => {
  mockRetry.mockReset();
  mockReplace.mockReset();
  setOnline(true);
});

afterEach(() => cleanup());

/** POS-PERF-P69R — the truthful state for a reload that couldn't check the session. */
describe('SessionUnconfirmedNotice', () => {
  it('says the sign-in could not be confirmed offline, never that no branch is assigned', () => {
    setOnline(false);
    render(<SessionUnconfirmedNotice />);
    expect(screen.getByRole('heading', { name: "Can't confirm your sign-in while offline" })).toBeInTheDocument();
    expect(screen.queryByText(/no branch assigned/i)).not.toBeInTheDocument();
    expect(mockRetry).not.toHaveBeenCalled();
  });

  it('tries again by itself when the connection returns, and continues on a restored session', async () => {
    setOnline(false);
    mockRetry.mockResolvedValue('restored');
    render(<SessionUnconfirmedNotice />);
    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(mockRetry).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: "Can't reach the server to confirm your sign-in" })).toBeInTheDocument();
  });

  it('goes to sign-in only when the server definitively ends the session', async () => {
    mockRetry.mockResolvedValue('ended');
    render(<SessionUnconfirmedNotice />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(mockReplace).toHaveBeenCalledWith('/login');
  });

  it('collapses repeated retries while one is in flight', async () => {
    let resolve: (value: string) => void = () => {};
    mockRetry.mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<SessionUnconfirmedNotice />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
    });
    expect(mockRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
    await act(async () => resolve('unconfirmed'));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
