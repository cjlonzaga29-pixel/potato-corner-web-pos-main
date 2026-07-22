import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ActiveSessionsSection } from './active-sessions-section';
import type { SessionResponse } from '@/hooks/queries/use-sessions';

const { mockUseActiveSessions, mockUseRevokeSession } = vi.hoisted(() => ({
  mockUseActiveSessions: vi.fn(),
  mockUseRevokeSession: vi.fn(),
}));

vi.mock('@/hooks/queries/use-sessions', () => ({
  useActiveSessions: mockUseActiveSessions,
  useRevokeSession: mockUseRevokeSession,
}));

function session(overrides: Partial<SessionResponse> = {}): SessionResponse {
  return {
    id: 'session-1',
    deviceId: 'device-aaaaaaaa-bbbb',
    deviceLabel: 'Device aaaaaaaa',
    createdAt: '2026-07-20T00:00:00.000Z',
    expiresAt: '2026-08-20T00:00:00.000Z',
    isCurrent: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ActiveSessionsSection', () => {
  it('renders a loading skeleton initially', () => {
    mockUseActiveSessions.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    mockUseRevokeSession.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    const { container } = render(<ActiveSessionsSection />);

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders the session list when loaded', () => {
    mockUseActiveSessions.mockReturnValue({
      data: [session({ id: 'session-1', deviceLabel: 'Device aaaaaaaa' }), session({ id: 'session-2', deviceLabel: 'Device bbbbbbbb' })],
      isLoading: false,
      isError: false,
    });
    mockUseRevokeSession.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<ActiveSessionsSection />);

    expect(screen.getByText('Device aaaaaaaa')).toBeInTheDocument();
    expect(screen.getByText('Device bbbbbbbb')).toBeInTheDocument();
  });

  it('shows the "This device" badge on the current session', () => {
    mockUseActiveSessions.mockReturnValue({
      data: [session({ id: 'session-1', isCurrent: true })],
      isLoading: false,
      isError: false,
    });
    mockUseRevokeSession.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<ActiveSessionsSection />);

    expect(screen.getByText('This device')).toBeInTheDocument();
  });

  it('disables the Sign out button on the current session', () => {
    mockUseActiveSessions.mockReturnValue({
      data: [session({ id: 'session-1', isCurrent: true })],
      isLoading: false,
      isError: false,
    });
    mockUseRevokeSession.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<ActiveSessionsSection />);

    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled();
  });

  it('opens a confirmation dialog when Sign out is clicked', () => {
    mockUseActiveSessions.mockReturnValue({
      data: [session({ id: 'session-1', deviceLabel: 'Device aaaaaaaa', isCurrent: false })],
      isLoading: false,
      isError: false,
    });
    mockUseRevokeSession.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<ActiveSessionsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(screen.getByText('Sign out this device?')).toBeInTheDocument();
  });
});
