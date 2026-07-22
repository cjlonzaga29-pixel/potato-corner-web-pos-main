import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const { mockUseSocketStore, mockUseAuthStore, mockUseRealtimeFeed, mockUseShifts, mockUseShiftsRealtimeSync, mockUseBranches, mockUseEmployees } =
  vi.hoisted(() => ({
    mockUseSocketStore: vi.fn(),
    mockUseAuthStore: vi.fn(),
    mockUseRealtimeFeed: vi.fn(),
    mockUseShifts: vi.fn(),
    mockUseShiftsRealtimeSync: vi.fn(),
    mockUseBranches: vi.fn(),
    mockUseEmployees: vi.fn(),
  }));

vi.mock('@/stores/socket.store', () => ({ useSocketStore: mockUseSocketStore }));
vi.mock('@/stores/auth.store', () => ({ useAuthStore: mockUseAuthStore }));
vi.mock('@/hooks/use-realtime-feed', () => ({ useRealtimeFeed: mockUseRealtimeFeed }));
vi.mock('@/hooks/queries/use-shifts', () => ({ useShifts: mockUseShifts, useShiftsRealtimeSync: mockUseShiftsRealtimeSync }));
vi.mock('@/hooks/queries/use-branches', () => ({ useBranches: mockUseBranches }));
vi.mock('@/hooks/queries/use-employees', () => ({ useEmployees: mockUseEmployees }));

const MonitoringPage = (await import('./page.js')).default;

beforeEach(() => {
  mockUseSocketStore.mockImplementation((selector: (s: { isConnected: boolean; isReconnecting: boolean }) => unknown) =>
    selector({ isConnected: true, isReconnecting: false }),
  );
  mockUseAuthStore.mockImplementation((selector: (s: { isLoading: boolean; accessToken: string | null }) => unknown) =>
    selector({ isLoading: false, accessToken: 'token-1' }),
  );
  mockUseRealtimeFeed.mockReturnValue([]);
  mockUseShiftsRealtimeSync.mockReturnValue(undefined);
  mockUseShifts.mockReturnValue({ data: { shifts: [], total: 0, page: 1, limit: 100 }, isLoading: false });
  mockUseBranches.mockReturnValue({ data: { branches: [], total: 0, page: 1, limit: 100 }, isLoading: false });
  mockUseEmployees.mockReturnValue({ data: { employees: [], total: 0, page: 1, limit: 100 }, isLoading: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MonitoringPage', () => {
  it('renders 4 panels', () => {
    render(<MonitoringPage />);
    expect(screen.getByText('Live Transaction Feed')).toBeInTheDocument();
    expect(screen.getByText('Active Cashiers')).toBeInTheDocument();
    expect(screen.getByText('Live Alerts Stream')).toBeInTheDocument();
    expect(screen.getByText('Branch Connection Status')).toBeInTheDocument();
  });

  it('renders the connection status indicator', () => {
    render(<MonitoringPage />);
    expect(screen.getByTitle('Connected')).toBeInTheDocument();
  });

  it('renders a loading skeleton initially while auth is restoring', () => {
    mockUseAuthStore.mockImplementation((selector: (s: { isLoading: boolean; accessToken: string | null }) => unknown) =>
      selector({ isLoading: true, accessToken: null }),
    );
    const { container } = render(<MonitoringPage />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('shows empty state per panel when there is no activity', () => {
    render(<MonitoringPage />);
    expect(screen.getAllByText('Waiting for activity...').length).toBeGreaterThan(0);
    expect(screen.getByText('No active shifts')).toBeInTheDocument();
  });
});
