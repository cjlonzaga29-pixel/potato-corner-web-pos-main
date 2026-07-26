import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BranchSelector } from './branch-selector';

const { mockUseBranchStore, mockUseBranches } = vi.hoisted(() => ({
  mockUseBranchStore: vi.fn(),
  mockUseBranches: vi.fn(),
}));

vi.mock('@/stores/branch.store', () => ({
  useBranchStore: mockUseBranchStore,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
}));

/** Flat, always-rendered list — Radix's DropdownMenuContent only mounts on open, which just adds noise here; same approach recipe-overrides-view.test.tsx uses for Select. */
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => <div data-testid="dropdown-content">{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <div role="menuitem" onClick={onClick}>
      {children}
    </div>
  ),
}));

function clickMenuItem(name: string) {
  const content = screen.getByTestId('dropdown-content');
  const item = within(content).getAllByRole('menuitem').find((el) => el.textContent?.includes(name));
  if (!item) throw new Error(`No menu item found containing "${name}"`);
  fireEvent.click(item);
}

function branch(id: string, name: string) {
  return {
    id,
    name,
    code: `PC-${id}`,
    address: '123 St',
    city: 'Manila',
    gpsLatitude: null,
    gpsLongitude: null,
    gpsRadiusMeters: 100,
    status: 'active' as const,
    gcashQrUrl: null,
    gcashQrKey: null,
    activeSupervisorCount: 0,
    activeStaffCount: 0,
    currentStatusLabel: 'Active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** Store mock is intentionally static per test (no real Zustand subscription) — assertions check the setActiveBranch call, not a re-rendered label. */
function mockStore(activeBranchId: string | null) {
  const setActiveBranch = vi.fn();
  mockUseBranchStore.mockReturnValue({
    activeBranchId,
    activeBranch: null,
    setActiveBranch,
    clearActiveBranch: vi.fn(),
  });
  return setActiveBranch;
}

function mockBranchesResult(branches: ReturnType<typeof branch>[], isLoading = false) {
  mockUseBranches.mockReturnValue({ data: { branches, total: branches.length, page: 1, limit: 100 }, isLoading });
}

beforeEach(() => {
  mockBranchesResult([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BranchSelector', () => {
  it('auto-selects the single accessible active branch when none is active yet', () => {
    const setActiveBranch = mockStore(null);
    mockBranchesResult([branch('branch-1', 'Manila')]);

    render(<BranchSelector />, { wrapper });

    expect(setActiveBranch).toHaveBeenCalledWith(expect.objectContaining({ id: 'branch-1' }));
  });

  it('lists every accessible branch and switches the active branch on selection', () => {
    const setActiveBranch = mockStore('branch-1');
    mockBranchesResult([branch('branch-1', 'Manila'), branch('branch-2', 'Cebu')]);

    render(<BranchSelector />, { wrapper });

    const content = screen.getByTestId('dropdown-content');
    expect(within(content).getByText('Manila')).toBeInTheDocument();
    expect(within(content).getByText('Cebu')).toBeInTheDocument();

    clickMenuItem('Cebu');

    expect(setActiveBranch).toHaveBeenCalledWith(expect.objectContaining({ id: 'branch-2' }));
  });

  it('discards a stale stored activeBranchId and selects the first accessible branch instead', () => {
    const setActiveBranch = mockStore('removed-branch-id');
    mockBranchesResult([branch('branch-1', 'Manila'), branch('branch-2', 'Cebu')]);

    render(<BranchSelector />, { wrapper });

    expect(setActiveBranch).toHaveBeenCalledWith(expect.objectContaining({ id: 'branch-1' }));
  });

  it('leaves an already-valid activeBranchId untouched', () => {
    const setActiveBranch = mockStore('branch-2');
    mockBranchesResult([branch('branch-1', 'Manila'), branch('branch-2', 'Cebu')]);

    render(<BranchSelector />, { wrapper });

    expect(setActiveBranch).not.toHaveBeenCalled();
  });

  it('renders nothing and never auto-selects when there are no accessible active branches', () => {
    const setActiveBranch = mockStore(null);
    mockBranchesResult([]);

    const { container } = render(<BranchSelector />, { wrapper });

    expect(setActiveBranch).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('a branch the API newly returns (e.g. a fresh Super Admin assignment) is listed and selectable', () => {
    const setActiveBranch = mockStore('branch-1');
    // Simulates a supervisor already on branch-1 who has just been assigned
    // branch-3 by Super Admin — the API response is the source of truth,
    // there is no separate client-side allowlist to fall out of sync.
    mockBranchesResult([branch('branch-1', 'Manila'), branch('branch-3', 'Davao')]);

    render(<BranchSelector />, { wrapper });

    clickMenuItem('Davao');

    expect(setActiveBranch).toHaveBeenCalledWith(expect.objectContaining({ id: 'branch-3' }));
  });

  it('requests only active branches from the API', () => {
    mockStore(null);
    render(<BranchSelector />, { wrapper });
    expect(mockUseBranches).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
  });
});
