import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ROLES } from '@potato-corner/shared';
import { ProfilePageContent } from './profile-page-content';

const { mockUseAuth, mockUseUpdateProfile, mockMutateAsync, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUseUpdateProfile: vi.fn(),
  mockMutateAsync: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('@/hooks/use-auth', () => ({ useAuth: mockUseAuth }));
vi.mock('@/hooks/queries/use-profile', () => ({ useUpdateProfile: mockUseUpdateProfile }));
vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: mockToastError } }));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'system', setTheme: vi.fn() }) }));
vi.mock('@/components/profile/active-sessions-section', () => ({ ActiveSessionsSection: () => null }));
vi.mock('@/components/profile/two-factor-section', () => ({ TwoFactorSection: () => null }));

const BASE_USER = {
  id: 'user-1',
  role: ROLES.SUPER_ADMIN,
  email: 'potatocorner@admin.com',
  firstName: 'CJ',
  lastName: 'Lonzaga',
  branchIds: [],
};

function setup(overrides: Partial<Record<string, unknown>> = {}) {
  mockUseAuth.mockReturnValue({ user: BASE_USER });
  mockUseUpdateProfile.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false, ...overrides });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProfilePageContent — Name field', () => {
  it('prefills the input with the existing name', () => {
    setup();
    render(<ProfilePageContent />);

    expect(screen.getByLabelText('Name')).toHaveValue('CJ Lonzaga');
  });

  it('is editable', () => {
    setup();
    render(<ProfilePageContent />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Name' } });

    expect(screen.getByLabelText('Name')).toHaveValue('New Name');
  });

  it('Save Changes is disabled when the name has not changed', () => {
    setup();
    render(<ProfilePageContent />);

    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });

  it('Save Changes is enabled once the name is edited', () => {
    setup();
    render(<ProfilePageContent />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Name' } });

    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
  });

  it('Save Changes stays disabled for an empty name', () => {
    setup();
    render(<ProfilePageContent />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } });

    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });

  it('Save Changes stays disabled for a whitespace-only name', () => {
    setup();
    render(<ProfilePageContent />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '     ' } });

    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });

  it('trims leading/trailing whitespace before submitting', async () => {
    mockMutateAsync.mockResolvedValue(undefined);
    setup();
    render(<ProfilePageContent />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Trimmed Name  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledWith('Trimmed Name'));
  });

  it('shows "Saving..." and disables the button while the request is in flight', () => {
    setup({ isPending: true });
    render(<ProfilePageContent />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Name' } });

    const button = screen.getByRole('button', { name: 'Saving...' });
    expect(button).toBeDisabled();
    expect(screen.getByLabelText('Name')).toBeDisabled();
  });

  it('shows a success message and does not reset the input after a successful save', async () => {
    mockMutateAsync.mockResolvedValue(undefined);
    setup();
    render(<ProfilePageContent />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Name updated successfully'));
    expect(screen.getByLabelText('Name')).toHaveValue('New Name');
  });

  it('preserves the entered name and shows an error message on failure, allowing retry', async () => {
    mockMutateAsync.mockRejectedValue(new Error('Network error'));
    setup();
    render(<ProfilePageContent />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Network error'));
    expect(screen.getByLabelText('Name')).toHaveValue('New Name');
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
  });

  it('does not touch Email, Role, or Branches', () => {
    setup();
    render(<ProfilePageContent />);

    expect(screen.getByText('potatocorner@admin.com')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Role')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Branches')).not.toBeInTheDocument();
  });
});
