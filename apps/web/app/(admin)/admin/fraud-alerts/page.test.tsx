import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import * as React from 'react';
import type { BranchListResponse, BranchResponse, FraudAlertListResponse, FraudAlertResponse } from '@potato-corner/shared';
import FraudAlertsPage from './page';

const {
  mockPush,
  mockUsePathname,
  mockUseSearchParams,
  mockUseFraudAlerts,
  mockUseFraudAlertsRealtimeSync,
  mockUseInvestigateAlert,
  mockUseDismissAlert,
  mockUseEscalateAlert,
  mockUseBranches,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUsePathname: vi.fn(() => '/admin/fraud-alerts'),
  mockUseSearchParams: vi.fn(() => new URLSearchParams()),
  mockUseFraudAlerts: vi.fn(),
  mockUseFraudAlertsRealtimeSync: vi.fn(),
  mockUseInvestigateAlert: vi.fn(),
  mockUseDismissAlert: vi.fn(),
  mockUseEscalateAlert: vi.fn(),
  mockUseBranches: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: mockUsePathname,
  useSearchParams: mockUseSearchParams,
}));

vi.mock('@/hooks/queries/use-fraud-alerts', () => ({
  useFraudAlerts: mockUseFraudAlerts,
  useFraudAlertsRealtimeSync: mockUseFraudAlertsRealtimeSync,
  useInvestigateAlert: mockUseInvestigateAlert,
  useDismissAlert: mockUseDismissAlert,
  useEscalateAlert: mockUseEscalateAlert,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
}));

// KpiCard's NumberTicker animates via Framer Motion + IntersectionObserver,
// neither of which resolve synchronously (or exist) in jsdom. Swapping in a
// plain, synchronous render (matching the admin dashboard test's approach)
// lets these tests verify the computed KPI values the page passes down.
vi.mock('@/components/shared/charts/kpi-card', () => ({
  KpiCard: ({ title, value, isLoading }: { title: string; value: number; isLoading?: boolean }) => (
    <div>
      <span>{title}</span>
      <span>{isLoading ? 'loading' : value}</span>
    </div>
  ),
}));

/**
 * The real Select is Radix-based (portals, pointer-capture) and has no
 * jsdom-friendly interaction path without @testing-library/user-event, which
 * isn't a project dependency. Standing it up as a flat, always-rendered
 * button list keeps the filter selects testable via plain fireEvent.click
 * while leaving the real component untouched (mirrors the admin attendance
 * page test's mock).
 */
vi.mock('@/components/ui/select', () => {
  const SelectContext = React.createContext<{ onValueChange?: (value: string) => void }>({});

  function Select({
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children?: React.ReactNode;
  }) {
    return <SelectContext.Provider value={{ onValueChange }}>{children}</SelectContext.Provider>;
  }
  function SelectTrigger({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectValue() {
    return null;
  }
  function SelectContent({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectItem({ value, children }: { value: string; children?: React.ReactNode }) {
    const ctx = React.useContext(SelectContext);
    return (
      <button type="button" onClick={() => ctx.onValueChange?.(value)}>
        {children}
      </button>
    );
  }

  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

function branch(overrides: Partial<BranchResponse> = {}): BranchResponse {
  return {
    id: 'branch-1',
    name: 'Main Branch',
    code: 'PC-MNL-001',
    address: '123 Rizal St',
    city: 'Manila',
    gpsLatitude: 14.5995,
    gpsLongitude: 120.9842,
    gpsRadiusMeters: 100,
    status: 'active',
    gcashQrUrl: null,
    gcashQrKey: null,
    activeSupervisorCount: 1,
    activeStaffCount: 5,
    currentStatusLabel: 'Open',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fraudAlert(overrides: Partial<FraudAlertResponse> = {}): FraudAlertResponse {
  return {
    id: 'alert-1',
    alert_type: 'excessive_void_rate',
    severity: 'high',
    status: 'open',
    branch_id: 'branch-1',
    branch_name: 'Main Branch',
    employee_id: 'employee-1',
    employee_name: 'Juan Dela Cruz',
    evidence: {},
    investigated_by: null,
    dismissal_reason: null,
    created_at: '2026-07-16T02:00:00.000Z',
    updated_at: '2026-07-16T02:00:00.000Z',
    ...overrides,
  };
}

function branchListResponse(overrides: Partial<BranchListResponse> = {}): BranchListResponse {
  return { branches: [branch()], total: 1, page: 1, limit: 100, ...overrides };
}

function fraudAlertListResponse(overrides: Partial<FraudAlertListResponse> = {}): FraudAlertListResponse {
  return { alerts: [fraudAlert()], total: 1, page: 1, limit: 25, ...overrides };
}

beforeEach(() => {
  mockUseSearchParams.mockReturnValue(new URLSearchParams());
  mockUseFraudAlertsRealtimeSync.mockReturnValue(undefined);
  mockUseBranches.mockReturnValue({ data: branchListResponse(), isLoading: false });
  mockUseFraudAlerts.mockReturnValue({ data: fraudAlertListResponse(), isLoading: false, isError: false, refetch: vi.fn() });
  mockUseInvestigateAlert.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, variables: undefined });
  mockUseDismissAlert.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, variables: undefined });
  mockUseEscalateAlert.mockReturnValue({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, variables: undefined });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FraudAlertsPage', () => {
  it('calls useFraudAlertsRealtimeSync on mount', () => {
    render(<FraudAlertsPage />);
    expect(mockUseFraudAlertsRealtimeSync).toHaveBeenCalled();
  });

  it('renders loading skeletons when isLoading is true', () => {
    mockUseFraudAlerts.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });

    render(<FraudAlertsPage />);

    expect(screen.getAllByText('loading').length).toBe(3);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('renders KpiCard counts derived from the current page of alerts', () => {
    mockUseFraudAlerts.mockReturnValue({
      data: fraudAlertListResponse({
        alerts: [
          fraudAlert({ id: 'a1', status: 'open' }),
          fraudAlert({ id: 'a2', status: 'open' }),
          fraudAlert({ id: 'a3', status: 'investigating' }),
          fraudAlert({ id: 'a4', status: 'escalated' }),
        ],
        total: 4,
      }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<FraudAlertsPage />);

    expect(screen.getByText('Open Alerts')).toBeInTheDocument();
    expect(screen.getByText('Under Investigation')).toBeInTheDocument();
    // "Escalated" also appears as a status-filter option, so scope to the
    // KpiCard mock's <span> title (the filter renders its options as <button>).
    expect(screen.getByText('Escalated', { selector: 'span' })).toBeInTheDocument();
    // Two "open" alerts -> 2, one "investigating" -> 1, one "escalated" -> 1
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getAllByText('1').length).toBe(2);
  });

  it('renders the "no alerts" empty state when there are no alerts and no filters applied', () => {
    mockUseFraudAlerts.mockReturnValue({
      data: fraudAlertListResponse({ alerts: [], total: 0 }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<FraudAlertsPage />);

    expect(screen.getByText('No fraud alerts found')).toBeInTheDocument();
  });

  it('renders the "no matches" empty state with a clear-filters action when filters are applied', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('status=open'));
    mockUseFraudAlerts.mockReturnValue({
      data: fraudAlertListResponse({ alerts: [], total: 0 }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<FraudAlertsPage />);

    expect(screen.getByText('No alerts match the current filters')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(mockPush).toHaveBeenCalledWith('/admin/fraud-alerts', { scroll: false });
  });

  it('renders DataTable rows when alerts exist', () => {
    mockUseFraudAlerts.mockReturnValue({
      data: fraudAlertListResponse({ alerts: [fraudAlert({ employee_name: 'Juan Dela Cruz', branch_name: 'Main Branch' })] }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<FraudAlertsPage />);

    const table = screen.getByRole('table');
    expect(within(table).getByText('Juan Dela Cruz')).toBeInTheDocument();
    expect(within(table).getByText('Main Branch')).toBeInTheDocument();
  });

  it('calls useInvestigateAlert when the Investigate flow is confirmed', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseInvestigateAlert.mockReturnValue({ mutate: vi.fn(), mutateAsync, isPending: false, variables: undefined });
    mockUseFraudAlerts.mockReturnValue({
      data: fraudAlertListResponse({ alerts: [fraudAlert({ id: 'alert-open', status: 'open' })] }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<FraudAlertsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Investigate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Investigation' }));

    expect(mutateAsync).toHaveBeenCalledWith({ id: 'alert-open' });
  });

  it('calls useEscalateAlert when the Escalate flow is confirmed', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseEscalateAlert.mockReturnValue({ mutate: vi.fn(), mutateAsync, isPending: false, variables: undefined });
    mockUseFraudAlerts.mockReturnValue({
      data: fraudAlertListResponse({ alerts: [fraudAlert({ id: 'alert-escalate', status: 'investigating' })] }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<FraudAlertsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Escalate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm Escalation' }));

    expect(mutateAsync).toHaveBeenCalledWith({ id: 'alert-escalate' });
  });

  it('opens the DismissFraudAlertDialog when Dismiss is clicked', async () => {
    mockUseFraudAlerts.mockReturnValue({
      data: fraudAlertListResponse({ alerts: [fraudAlert({ id: 'alert-dismiss', status: 'open' })] }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<FraudAlertsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(await screen.findByText('Dismiss Fraud Alert')).toBeInTheDocument();
    expect(screen.getByLabelText(/Dismissal Reason/)).toBeInTheDocument();
  });

  it('resets page to 1 when the status filter changes', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('page=3'));

    render(<FraudAlertsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(mockPush).toHaveBeenCalledWith('/admin/fraud-alerts?page=1&status=open', { scroll: false });
  });
});
