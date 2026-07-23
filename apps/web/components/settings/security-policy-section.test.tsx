import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SecurityPolicySection } from './security-policy-section';

const { mockUseSecurityPolicy, mockUseUpdateSecurityPolicy, mockUseAuthStore } = vi.hoisted(() => ({
  mockUseSecurityPolicy: vi.fn(),
  mockUseUpdateSecurityPolicy: vi.fn(),
  mockUseAuthStore: vi.fn(),
}));

vi.mock('@/hooks/queries/use-settings', () => ({
  useSecurityPolicy: mockUseSecurityPolicy,
  useUpdateSecurityPolicy: mockUseUpdateSecurityPolicy,
}));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: mockUseAuthStore,
}));

const POLICY = {
  sessionTimeoutMinutes: 60,
  passwordMinLength: 8,
  requirePasswordComplexity: true,
  require2faForAdmins: false,
  require2faForSupervisors: false,
  maxFailedLoginAttempts: 5,
  lockoutDurationMinutes: 30,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SecurityPolicySection', () => {
  it('renders loading skeleton initially', () => {
    mockUseAuthStore.mockReturnValue(true);
    mockUseSecurityPolicy.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    mockUseUpdateSecurityPolicy.mockReturnValue({ mutate: vi.fn(), isPending: false });

    const { container } = render(<SecurityPolicySection />);

    expect(container.querySelectorAll('[class*="animate-pulse"]').length).toBeGreaterThan(0);
  });

  it('populates form with fetched values', () => {
    mockUseAuthStore.mockReturnValue(true);
    mockUseSecurityPolicy.mockReturnValue({ data: POLICY, isLoading: false, isError: false });
    mockUseUpdateSecurityPolicy.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<SecurityPolicySection />);

    expect(screen.getByLabelText('Session timeout (minutes)')).toHaveValue(60);
    expect(screen.getByLabelText('Password minimum length')).toHaveValue(8);
  });

  it('save calls update mutation', () => {
    mockUseAuthStore.mockReturnValue(true);
    mockUseSecurityPolicy.mockReturnValue({ data: POLICY, isLoading: false, isError: false });
    const mockMutate = vi.fn();
    mockUseUpdateSecurityPolicy.mockReturnValue({ mutate: mockMutate, isPending: false });

    render(<SecurityPolicySection />);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mockMutate).toHaveBeenCalledWith(POLICY);
  });

  it('shows read-only view for non-super-admin', () => {
    mockUseAuthStore.mockReturnValue(false);
    mockUseSecurityPolicy.mockReturnValue({ data: POLICY, isLoading: false, isError: false });
    mockUseUpdateSecurityPolicy.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<SecurityPolicySection />);

    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.getByText('60')).toBeInTheDocument();
  });
});
