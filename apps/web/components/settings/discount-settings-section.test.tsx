import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { DiscountSettingsSection } from './discount-settings-section';

const { mockUseDiscountPolicy, mockUseUpdateDiscountPolicy, MockSettingsSaveError } = vi.hoisted(() => {
  class MockSettingsSaveError extends Error {
    constructor(
      message: string,
      public readonly code: string | null,
    ) {
      super(message);
    }
  }
  return { mockUseDiscountPolicy: vi.fn(), mockUseUpdateDiscountPolicy: vi.fn(), MockSettingsSaveError };
});

vi.mock('@/hooks/queries/use-settings', () => ({
  useDiscountPolicy: mockUseDiscountPolicy,
  useUpdateDiscountPolicy: mockUseUpdateDiscountPolicy,
  SettingsSaveError: MockSettingsSaveError,
}));

const SAVED_AT = '2026-10-01T00:00:00.000Z';
function policy(overrides: Record<string, { percentage: number; isEnabled: boolean }> = {}) {
  return {
    pwd: { percentage: 20, isEnabled: true },
    senior_citizen: { percentage: 20, isEnabled: true },
    employee: { percentage: 15, isEnabled: true },
    promotional: { percentage: 20, isEnabled: true },
    updatedAt: SAVED_AT,
    updatedBy: 'admin-1',
    statutoryTypes: ['pwd', 'senior_citizen'],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DiscountSettingsSection (P50)', () => {
  it('shows PWD and Senior Citizen as read-only statutory rows with no inputs or switches', () => {
    mockUseDiscountPolicy.mockReturnValue({ data: policy(), isLoading: false, isError: false });
    mockUseUpdateDiscountPolicy.mockReturnValue({ mutate: vi.fn(), isPending: false });
    render(<DiscountSettingsSection />);

    for (const type of ['pwd', 'senior_citizen']) {
      const row = screen.getByTestId(`discount-row-${type}`);
      expect(within(row).getByText(/Set by law/)).toBeInTheDocument();
      expect(within(row).getByText('20%')).toBeInTheDocument();
      expect(within(row).queryByRole('spinbutton')).not.toBeInTheDocument();
      expect(within(row).queryByRole('switch')).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('saves only the Employee row, with the updatedAt it loaded, and only once something changed', () => {
    const mutate = vi.fn();
    mockUseDiscountPolicy.mockReturnValue({ data: policy(), isLoading: false, isError: false });
    mockUseUpdateDiscountPolicy.mockReturnValue({ mutate, isPending: false });
    render(<DiscountSettingsSection />);

    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(mutate).toHaveBeenCalledWith({ employee: { percentage: 10, isEnabled: true }, expectedUpdatedAt: SAVED_AT }, expect.any(Object));
  });

  it('a stale save (SETTINGS_CHANGED) explains that someone else changed the settings', () => {
    const mutate = vi.fn((_input: unknown, options: { onError: (error: Error) => void }) =>
      options.onError(new MockSettingsSaveError('changed', 'SETTINGS_CHANGED')),
    );
    mockUseDiscountPolicy.mockReturnValue({ data: policy(), isLoading: false, isError: false });
    mockUseUpdateDiscountPolicy.mockReturnValue({ mutate, isPending: false });
    render(<DiscountSettingsSection />);

    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(screen.getByTestId('discount-settings-conflict')).toHaveTextContent('Someone else changed these settings');
  });

  it('a legacy non-statutory PWD value is flagged and can only be restored to 20%', () => {
    const mutate = vi.fn();
    mockUseDiscountPolicy.mockReturnValue({ data: policy({ pwd: { percentage: 10, isEnabled: true } }), isLoading: false, isError: false });
    mockUseUpdateDiscountPolicy.mockReturnValue({ mutate, isPending: false });
    render(<DiscountSettingsSection />);

    expect(screen.getByRole('alert')).toHaveTextContent('not the 20% (enabled) required by law');
    fireEvent.click(screen.getByRole('button', { name: 'Restore 20% for PWD and Senior Citizen' }));
    expect(mutate).toHaveBeenCalledWith(
      { pwd: { percentage: 20, isEnabled: true }, senior_citizen: { percentage: 20, isEnabled: true }, expectedUpdatedAt: SAVED_AT },
      expect.any(Object),
    );
  });
});

describe('DiscountSettingsSection idle query (P50 browser finding)', () => {
  it('shows skeletons, never an empty card, before the query has run', () => {
    mockUseDiscountPolicy.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    mockUseUpdateDiscountPolicy.mockReturnValue({ mutate: vi.fn(), isPending: false });
    const { container } = render(<DiscountSettingsSection />);
    expect(container.querySelectorAll('[class*="animate-pulse"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
  });
});
