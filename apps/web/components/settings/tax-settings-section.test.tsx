import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { TaxSettingsSection } from './tax-settings-section';

const { mockUseTaxConfiguration } = vi.hoisted(() => ({ mockUseTaxConfiguration: vi.fn() }));

vi.mock('@/hooks/queries/use-settings', () => ({ useTaxConfiguration: mockUseTaxConfiguration }));

const CONFIG = {
  vatRatePercent: 12,
  pricesIncludeVat: true,
  statutoryDiscountPercent: 20,
  vatExemptDiscountTypes: ['pwd', 'senior_citizen'],
  scope: 'organization' as const,
  discountRates: { pwd: 20, senior_citizen: 20, employee: 10 },
  statutoryRateMismatch: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TaxSettingsSection (P50)', () => {
  it('has no inputs and explains rate, inclusive pricing, exemption, scope and the basis of each value', () => {
    mockUseTaxConfiguration.mockReturnValue({ data: CONFIG, isLoading: false, isError: false });
    render(<TaxSettingsSection />);

    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    const rows = screen.getByTestId('tax-settings-rows');
    expect(within(rows).getByText('12%')).toBeInTheDocument();
    expect(within(rows).getByText('Include VAT')).toBeInTheDocument();
    // POS-PERF-P50R — Senior and PWD are separate rows: Senior exactly 20%, PWD at least 20%.
    expect(within(rows).getAllByText('20% off, VAT-exempt')).toHaveLength(2);
    expect(within(rows).getByText(/Exactly 20%; not editable/)).toBeInTheDocument();
    expect(within(rows).getByText(/At least 20%: it may be raised per branch/)).toBeInTheDocument();
    expect(within(rows).getAllByText(/Set by law/)).toHaveLength(3);
    expect(within(rows).getByText(/^Business choice\.$/)).toBeInTheDocument();
    expect(screen.getByText(/manual checkout is subtotal − discount = amount to pay/)).toBeInTheDocument();
  });

  it('works the ₱112 example with the same calculation checkout uses', () => {
    mockUseTaxConfiguration.mockReturnValue({ data: CONFIG, isLoading: false, isError: false });
    render(<TaxSettingsSection />);
    const rows = within(screen.getByTestId('tax-example')).getAllByRole('row');
    // Ordinary: ₱100 VATable + ₱12 VAT = ₱112.
    expect(rows[1]).toHaveTextContent('₱100.00');
    expect(rows[1]).toHaveTextContent('₱12.00');
    expect(rows[1]).toHaveTextContent('₱112.00');
    // PWD/Senior: ₱100 − ₱20, no VAT → ₱80.
    expect(rows[2]).toHaveTextContent('-₱20.00');
    expect(rows[2]).toHaveTextContent('₱0.00');
    expect(rows[2]).toHaveTextContent('₱80.00');
    // Employee 10%: ₱112 − ₱11.20 = ₱100.80, VAT ₱10.80 inside it.
    expect(rows[3]).toHaveTextContent('Employee (10%)');
    expect(rows[3]).toHaveTextContent('-₱11.20');
    expect(rows[3]).toHaveTextContent('₱10.80');
    expect(rows[3]).toHaveTextContent('₱100.80');
  });

  it('flags a stored PWD/Senior rate that is not the statutory value', () => {
    mockUseTaxConfiguration.mockReturnValue({
      data: { ...CONFIG, discountRates: { pwd: 10, senior_citizen: 20, employee: 20 }, statutoryRateMismatch: true },
      isLoading: false,
      isError: false,
    });
    render(<TaxSettingsSection />);
    expect(screen.getByRole('alert')).toHaveTextContent('(10% / 20%) is outside what the law requires');
  });

  it('an API without the endpoint: says so and shows this build’s values', () => {
    mockUseTaxConfiguration.mockReturnValue({ data: null, isLoading: false, isError: false });
    render(<TaxSettingsSection />);
    expect(screen.getByText(/does not report its tax configuration yet/)).toBeInTheDocument();
    expect(within(screen.getByTestId('tax-settings-rows')).getByText('12%')).toBeInTheDocument();
  });
});

describe('TaxSettingsSection idle query (P50 browser finding)', () => {
  it('shows a loading state, not fallback values, before the query has run', () => {
    mockUseTaxConfiguration.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    render(<TaxSettingsSection />);
    expect(screen.queryByTestId('tax-settings-rows')).not.toBeInTheDocument();
    cleanup();
  });
});
