import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ReceiptTemplatesSection } from './receipt-templates-section';

const { mockUseBranches, mockUseBranchReceiptConfig, mockUseUpdateBranchReceiptConfig, mockUseAuthStore } = vi.hoisted(() => ({
  mockUseBranches: vi.fn(),
  mockUseBranchReceiptConfig: vi.fn(),
  mockUseUpdateBranchReceiptConfig: vi.fn(),
  mockUseAuthStore: vi.fn(),
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
}));

vi.mock('@/hooks/queries/use-settings', () => ({
  useBranchReceiptConfig: mockUseBranchReceiptConfig,
  useUpdateBranchReceiptConfig: mockUseUpdateBranchReceiptConfig,
}));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: mockUseAuthStore,
}));

/** Flat, always-rendered list — same approach as expenses/page.test.tsx for the real Radix Select. */
vi.mock('@/components/ui/select', () => {
  const SelectContext = React.createContext<{ onValueChange?: (value: string) => void }>({});

  function Select({ onValueChange, children }: { onValueChange?: (value: string) => void; children?: React.ReactNode }) {
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

const BRANCHES = { branches: [{ id: 'branch-1', name: 'Main Branch' }], total: 1, page: 1, limit: 100 };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ReceiptTemplatesSection', () => {
  it('renders branch selector + form', () => {
    mockUseAuthStore.mockReturnValue(true);
    mockUseBranches.mockReturnValue({ data: BRANCHES });
    mockUseBranchReceiptConfig.mockReturnValue({ data: null, isLoading: false, isError: false });
    mockUseUpdateBranchReceiptConfig.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<ReceiptTemplatesSection />);

    expect(screen.getByText('Main Branch')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Main Branch'));

    expect(screen.getByLabelText('Header text')).toBeInTheDocument();
    expect(screen.getByLabelText('Footer text')).toBeInTheDocument();
  });

  it('loads config when branch selected', () => {
    mockUseAuthStore.mockReturnValue(true);
    mockUseBranches.mockReturnValue({ data: BRANCHES });
    mockUseBranchReceiptConfig.mockReturnValue({
      data: { branchId: 'branch-1', headerText: 'Welcome!', footerText: 'Thank you!', showBranchLogo: true, updatedAt: '2026-01-01T00:00:00.000Z' },
      isLoading: false,
      isError: false,
    });
    mockUseUpdateBranchReceiptConfig.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<ReceiptTemplatesSection />);
    fireEvent.click(screen.getByText('Main Branch'));

    expect(screen.getByLabelText('Header text')).toHaveValue('Welcome!');
    expect(screen.getByLabelText('Footer text')).toHaveValue('Thank you!');
  });

  it('character counters on textareas', () => {
    mockUseAuthStore.mockReturnValue(true);
    mockUseBranches.mockReturnValue({ data: BRANCHES });
    mockUseBranchReceiptConfig.mockReturnValue({ data: null, isLoading: false, isError: false });
    mockUseUpdateBranchReceiptConfig.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<ReceiptTemplatesSection />);
    fireEvent.click(screen.getByText('Main Branch'));

    fireEvent.change(screen.getByLabelText('Header text'), { target: { value: 'Hello' } });

    expect(screen.getByText('5/500')).toBeInTheDocument();
  });
});
