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

describe('DiscountSettingsSection (P50 / P50R organization defaults)', () => {
  it('shows Senior Citizen as a locked statutory row; PWD is editable from 20% up for a Super Admin', () => {
    mockUseDiscountPolicy.mockReturnValue({ data: policy(), isLoading: false, isError: false });
    mockUseUpdateDiscountPolicy.mockReturnValue({ mutate: vi.fn(), isPending: false });
    render(<DiscountSettingsSection canEdit />);

    const senior = screen.getByTestId('discount-row-senior_citizen');
    expect(within(senior).getByText(/Set by law/)).toBeInTheDocument();
    expect(within(senior).queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(within(senior).queryByRole('switch')).not.toBeInTheDocument();
    const pwd = screen.getByTestId('discount-row-pwd');
    expect(within(pwd).getByText(/at least 20%/)).toBeInTheDocument();
    expect(within(pwd).getByRole('spinbutton')).toHaveValue(20);
    expect(within(pwd).queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('saves Employee, and a raised PWD, with the updatedAt it loaded, only once something changed', () => {
    const mutate = vi.fn();
    mockUseDiscountPolicy.mockReturnValue({ data: policy(), isLoading: false, isError: false });
    mockUseUpdateDiscountPolicy.mockReturnValue({ mutate, isPending: false });
    render(<DiscountSettingsSection canEdit />);

    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(mutate).toHaveBeenLastCalledWith({ employee: { percentage: 10, isEnabled: true }, expectedUpdatedAt: SAVED_AT }, expect.any(Object));

    fireEvent.change(screen.getByLabelText('PWD'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(mutate).toHaveBeenLastCalledWith({ employee: { percentage: 10, isEnabled: true }, pwd: { percentage: 25 }, expectedUpdatedAt: SAVED_AT }, expect.any(Object));
  });

  it('a PWD value below 20% is explained and cannot be saved', () => {
    mockUseDiscountPolicy.mockReturnValue({ data: policy(), isLoading: false, isError: false });
    mockUseUpdateDiscountPolicy.mockReturnValue({ mutate: vi.fn(), isPending: false });
    render(<DiscountSettingsSection canEdit />);

    fireEvent.change(screen.getByLabelText('PWD'), { target: { value: '15' } });
    expect(screen.getByText(/does not allow less than 20%/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });

  it('read-only for non-admins: values shown, no inputs, no Save', () => {
    mockUseDiscountPolicy.mockReturnValue({ data: policy(), isLoading: false, isError: false });
    mockUseUpdateDiscountPolicy.mockReturnValue({ mutate: vi.fn(), isPending: false });
    render(<DiscountSettingsSection canEdit={false} />);

    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
    expect(screen.getByText(/Only a Super Admin changes these defaults/)).toBeInTheDocument();
  });

  it('a stale save (SETTINGS_CHANGED) explains that someone else changed the settings', () => {
    const mutate = vi.fn((_input: unknown, options: { onError: (error: Error) => void }) =>
      options.onError(new MockSettingsSaveError('changed', 'SETTINGS_CHANGED')),
    );
    mockUseDiscountPolicy.mockReturnValue({ data: policy(), isLoading: false, isError: false });
    mockUseUpdateDiscountPolicy.mockReturnValue({ mutate, isPending: false });
    render(<DiscountSettingsSection canEdit />);

    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(screen.getByTestId('discount-settings-conflict')).toHaveTextContent('Someone else changed these settings');
  });

  it('a legacy below-statute PWD value is flagged and can be restored to 20%', () => {
    const mutate = vi.fn();
    mockUseDiscountPolicy.mockReturnValue({ data: policy({ pwd: { percentage: 10, isEnabled: true } }), isLoading: false, isError: false });
    mockUseUpdateDiscountPolicy.mockReturnValue({ mutate, isPending: false });
    render(<DiscountSettingsSection canEdit />);

    expect(screen.getByRole('alert')).toHaveTextContent('outside what the law requires');
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
    const { container } = render(<DiscountSettingsSection canEdit />);
    expect(container.querySelectorAll('[class*="animate-pulse"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
  });
});
