import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PaymentMethodsSection } from './payment-methods-section';

const { mockUseBranches, mockUsePaymentMethodConfig, mockUseUpdatePaymentMethodConfig, mockUseAuthStore } = vi.hoisted(() => ({
  mockUseBranches: vi.fn(),
  mockUsePaymentMethodConfig: vi.fn(),
  mockUseUpdatePaymentMethodConfig: vi.fn(),
  mockUseAuthStore: vi.fn(),
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
}));

vi.mock('@/hooks/queries/use-settings', () => ({
  usePaymentMethodConfig: mockUsePaymentMethodConfig,
  useUpdatePaymentMethodConfig: mockUseUpdatePaymentMethodConfig,
}));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: mockUseAuthStore,
}));

/** Flat, always-rendered list — same approach as receipt-templates-section.test.tsx for the real Radix Select. */
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

describe('PaymentMethodsSection', () => {
  it('renders branch selector + toggles', () => {
    mockUseAuthStore.mockReturnValue(true);
    mockUseBranches.mockReturnValue({ data: BRANCHES });
    mockUsePaymentMethodConfig.mockReturnValue({ data: null, isLoading: false, isError: false });
    mockUseUpdatePaymentMethodConfig.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<PaymentMethodsSection />);

    expect(screen.getByText('Main Branch')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Main Branch'));

    expect(screen.getByLabelText('Cash')).toBeInTheDocument();
    expect(screen.getByLabelText('GCash')).toBeInTheDocument();
  });

  it('loads config when branch selected', () => {
    mockUseAuthStore.mockReturnValue(true);
    mockUseBranches.mockReturnValue({ data: BRANCHES });
    mockUsePaymentMethodConfig.mockReturnValue({
      data: { branchId: 'branch-1', cashEnabled: true, gcashEnabled: false, updatedAt: '2026-01-01T00:00:00.000Z' },
      isLoading: false,
      isError: false,
    });
    mockUseUpdatePaymentMethodConfig.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<PaymentMethodsSection />);
    fireEvent.click(screen.getByText('Main Branch'));

    expect(screen.getByLabelText('Cash')).toBeChecked();
    expect(screen.getByLabelText('GCash')).not.toBeChecked();
  });

  it('disables turning off the last remaining enabled method', () => {
    mockUseAuthStore.mockReturnValue(true);
    mockUseBranches.mockReturnValue({ data: BRANCHES });
    mockUsePaymentMethodConfig.mockReturnValue({
      data: { branchId: 'branch-1', cashEnabled: true, gcashEnabled: false, updatedAt: '2026-01-01T00:00:00.000Z' },
      isLoading: false,
      isError: false,
    });
    mockUseUpdatePaymentMethodConfig.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<PaymentMethodsSection />);
    fireEvent.click(screen.getByText('Main Branch'));

    expect(screen.getByLabelText('Cash')).toBeDisabled();
    expect(screen.getByLabelText('GCash')).not.toBeDisabled();
  });

  it('calls update with both fields on save', () => {
    mockUseAuthStore.mockReturnValue(true);
    mockUseBranches.mockReturnValue({ data: BRANCHES });
    mockUsePaymentMethodConfig.mockReturnValue({
      data: { branchId: 'branch-1', cashEnabled: true, gcashEnabled: true, updatedAt: '2026-01-01T00:00:00.000Z' },
      isLoading: false,
      isError: false,
    });
    const mutate = vi.fn();
    mockUseUpdatePaymentMethodConfig.mockReturnValue({ mutate, isPending: false });

    render(<PaymentMethodsSection />);
    fireEvent.click(screen.getByText('Main Branch'));
    fireEvent.click(screen.getByLabelText('GCash'));
    fireEvent.click(screen.getByText('Save changes'));

    expect(mutate).toHaveBeenCalledWith({ cashEnabled: true, gcashEnabled: false });
  });

  it('hides the form for non-admins', () => {
    mockUseAuthStore.mockReturnValue(false);
    mockUseBranches.mockReturnValue({ data: BRANCHES });
    mockUsePaymentMethodConfig.mockReturnValue({ data: null, isLoading: false, isError: false });
    mockUseUpdatePaymentMethodConfig.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<PaymentMethodsSection />);

    expect(screen.getByText('Only Super Admins can configure payment methods.')).toBeInTheDocument();
  });
});
