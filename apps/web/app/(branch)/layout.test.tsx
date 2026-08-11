import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import BranchLayout from './layout';

const { mockUseAuth, mockUseBranch, mockUseBranchStore } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseBranch: vi.fn(),
  mockUseBranchStore: vi.fn(),
}));

vi.mock('@/hooks/use-auth', () => ({ useAuth: mockUseAuth }));
vi.mock('@/hooks/queries/use-branches', () => ({ useBranch: mockUseBranch }));
vi.mock('@/stores/branch.store', () => ({ useBranchStore: mockUseBranchStore }));

// The real sidebar/header/socket pull in far more than this layout-gating
// test cares about (nav auth, socket connections, notifications) — replaced
// with minimal stand-ins so only BranchLayout's own readiness logic is
// under test.
vi.mock('@/components/branch/branch-sidebar', () => ({
  BranchSidebar: () => <div data-testid="sidebar" />,
  BRANCH_NAV_ITEMS: [],
}));
vi.mock('@/components/branch/branch-context-sync', () => ({
  BranchContextSync: () => null,
}));
vi.mock('@/components/shared/dashboard-header', () => ({
  DashboardHeader: () => <div data-testid="header" />,
}));
vi.mock('@/components/shared/socket-initializer', () => ({
  SocketInitializer: () => null,
}));

const BRANCH_ID = '123e4567-e89b-12d3-a456-426614174000';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * Task 209.54 — regression coverage for the "No branch assigned" flash: a
 * correctly-staffed branch/staff account briefly has `user` (and therefore
 * `branchId`) null on every reload while useAuth's silent refresh is in
 * flight, and even once `user` resolves, useBranchStore's `activeBranchId`
 * (which every branch-ops page actually reads) isn't seeded until
 * BranchContextSync's own useBranch(branchId) fetch resolves too. Every one
 * of these states must render a loading spinner, not `children` — letting
 * children through prematurely is exactly what let pages like
 * /branch/dashboard and /branch/inventory render their "no branch"/"select
 * an active branch" empty states for a real, correctly-staffed account.
 */
describe('BranchLayout — branch context readiness gate', () => {
  it('shows a loading spinner (not children) while auth is still loading', () => {
    mockUseAuth.mockReturnValue({ user: null, isLoading: true });
    mockUseBranch.mockReturnValue({ isLoading: false, isError: false });
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
      selector({ activeBranchId: null }),
    );

    render(
      <BranchLayout>
        <div data-testid="page-content">Dashboard content</div>
      </BranchLayout>,
    );

    expect(screen.queryByTestId('page-content')).not.toBeInTheDocument();
  });

  it('shows a loading spinner while the branch fetch BranchContextSync depends on is still in flight', () => {
    mockUseAuth.mockReturnValue({ user: { branchIds: [BRANCH_ID] }, isLoading: false });
    mockUseBranch.mockReturnValue({ isLoading: true, isError: false });
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
      selector({ activeBranchId: null }),
    );

    render(
      <BranchLayout>
        <div data-testid="page-content">Dashboard content</div>
      </BranchLayout>,
    );

    expect(screen.queryByTestId('page-content')).not.toBeInTheDocument();
  });

  it('renders children once auth has loaded and activeBranchId matches the account branch', () => {
    mockUseAuth.mockReturnValue({ user: { branchIds: [BRANCH_ID] }, isLoading: false });
    mockUseBranch.mockReturnValue({ isLoading: false, isError: false });
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
      selector({ activeBranchId: BRANCH_ID }),
    );

    render(
      <BranchLayout>
        <div data-testid="page-content">Dashboard content</div>
      </BranchLayout>,
    );

    expect(screen.getByTestId('page-content')).toBeInTheDocument();
  });

  it('renders children (not stuck spinning) once auth has loaded and the account genuinely has no branch', () => {
    mockUseAuth.mockReturnValue({ user: { branchIds: [] }, isLoading: false });
    mockUseBranch.mockReturnValue({ isLoading: false, isError: false });
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
      selector({ activeBranchId: null }),
    );

    render(
      <BranchLayout>
        <div data-testid="page-content">No-branch empty state</div>
      </BranchLayout>,
    );

    expect(screen.getByTestId('page-content')).toBeInTheDocument();
  });

  it('renders children (not stuck spinning) if the branch fetch errors', () => {
    mockUseAuth.mockReturnValue({ user: { branchIds: [BRANCH_ID] }, isLoading: false });
    mockUseBranch.mockReturnValue({ isLoading: false, isError: true });
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
      selector({ activeBranchId: null }),
    );

    render(
      <BranchLayout>
        <div data-testid="page-content">Page content</div>
      </BranchLayout>,
    );

    expect(screen.getByTestId('page-content')).toBeInTheDocument();
  });
});
