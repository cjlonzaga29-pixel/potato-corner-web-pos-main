import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import * as React from 'react';
import ExpensesPage from './page';
import type { ExpenseListResponse, ExpenseRow } from '@/hooks/queries/use-expenses';
import type { BranchListResponse, BranchResponse } from '@potato-corner/shared';

const {
  mockPush,
  mockUsePathname,
  mockUseSearchParams,
  mockUseExpenses,
  mockUseSelectedBranch,
  mockUseBranches,
  mockDownloadCsv,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUsePathname: vi.fn(() => '/admin/expenses'),
  mockUseSearchParams: vi.fn(() => new URLSearchParams()),
  mockUseExpenses: vi.fn(),
  mockUseSelectedBranch: vi.fn(),
  mockUseBranches: vi.fn(),
  mockDownloadCsv: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: mockUsePathname,
  useSearchParams: mockUseSearchParams,
}));

vi.mock('@/hooks/queries/use-expenses', () => ({
  useExpenses: mockUseExpenses,
}));

vi.mock('@/hooks/use-selected-branch', () => ({
  useSelectedBranch: mockUseSelectedBranch,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
}));

vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return { ...actual, downloadCsv: mockDownloadCsv };
});

/**
 * The real Select is Radix-based (portals, pointer-capture) and has no
 * jsdom-friendly interaction path without @testing-library/user-event.
 * Standing it up as a flat, always-rendered button list keeps the filter
 * selects testable via plain fireEvent.click (mirrors the fraud-alerts
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

function expense(overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id: 'expense-1',
    branch_id: 'branch-1',
    branch_name: 'Main Branch',
    category: 'utilities',
    amount: 1250.5,
    vendor_name: 'Meralco',
    description: null,
    receipt_url: null,
    incurred_at: '2026-07-20T00:00:00.000Z',
    created_by: 'user-1',
    created_by_name: 'Juan Dela Cruz',
    created_at: '2026-07-20T02:00:00.000Z',
    ...overrides,
  };
}

function branchListResponse(overrides: Partial<BranchListResponse> = {}): BranchListResponse {
  return { branches: [branch()], total: 1, page: 1, limit: 100, ...overrides };
}

function expenseListResponse(overrides: Partial<ExpenseListResponse> = {}): ExpenseListResponse {
  return { expenses: [expense()], total: 1, total_amount: 1250.5, page: 1, limit: 25, ...overrides };
}

beforeEach(() => {
  mockUseSearchParams.mockReturnValue(new URLSearchParams());
  mockUseSelectedBranch.mockReturnValue({ selectedBranchId: 'all' });
  mockUseBranches.mockReturnValue({ data: branchListResponse(), isLoading: false });
  mockUseExpenses.mockReturnValue({ data: expenseListResponse(), isLoading: false, isError: false, refetch: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ExpensesPage', () => {
  it('renders the "no expenses" empty state when there are none and no filters applied', () => {
    mockUseExpenses.mockReturnValue({
      data: expenseListResponse({ expenses: [], total: 0, total_amount: 0 }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ExpensesPage />);

    expect(screen.getByText('No expenses recorded')).toBeInTheDocument();
  });

  it('renders the "no matches" empty state with a clear-filters action when filters are applied', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('category=utilities'));
    mockUseExpenses.mockReturnValue({
      data: expenseListResponse({ expenses: [], total: 0, total_amount: 0 }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ExpensesPage />);

    expect(screen.getByText('No expenses match the current filters')).toBeInTheDocument();
    const [clearButton] = screen.getAllByRole('button', { name: 'Clear filters' });
    if (!clearButton) throw new Error('Clear filters button not found');
    fireEvent.click(clearButton);
    expect(mockPush).toHaveBeenCalledWith('/admin/expenses', { scroll: false });
  });

  it('renders expense rows in the table when expenses exist', () => {
    mockUseExpenses.mockReturnValue({
      data: expenseListResponse({ expenses: [expense({ vendor_name: 'Meralco', branch_name: 'Main Branch' })] }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ExpensesPage />);

    const table = screen.getByRole('table');
    expect(within(table).getByText('Meralco')).toBeInTheDocument();
    expect(within(table).getByText('Main Branch')).toBeInTheDocument();
  });

  it('renders the running total derived from meta.total_amount', () => {
    mockUseExpenses.mockReturnValue({
      data: expenseListResponse({ total_amount: 9999.99 }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ExpensesPage />);

    expect(screen.getByText('₱9,999.99')).toBeInTheDocument();
  });

  it('pushes an updated branch_id URL param when the branch filter changes', () => {
    render(<ExpensesPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Main Branch' }));

    expect(mockPush).toHaveBeenCalledWith('/admin/expenses?branch_id=branch-1&page=1', { scroll: false });
  });

  it('pushes an updated category URL param when the category filter changes', () => {
    render(<ExpensesPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Utilities' }));

    expect(mockPush).toHaveBeenCalledWith('/admin/expenses?category=utilities&page=1', { scroll: false });
  });

  it('calls downloadCsv when the Export CSV button is clicked', () => {
    render(<ExpensesPage />);

    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));

    expect(mockDownloadCsv).toHaveBeenCalledTimes(1);
    expect(mockDownloadCsv).toHaveBeenCalledWith(expect.stringMatching(/^expenses-\d{4}-\d{2}-\d{2}\.csv$/), expect.any(Array), expect.any(Array));
  });

  it('disables the Export CSV button when there are no rows', () => {
    mockUseExpenses.mockReturnValue({
      data: expenseListResponse({ expenses: [], total: 0, total_amount: 0 }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<ExpensesPage />);

    expect(screen.getByRole('button', { name: /Export CSV/ })).toBeDisabled();
  });
});
