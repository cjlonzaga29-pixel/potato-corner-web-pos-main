import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import ChangePasswordPage from './page';

const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));
const { apiClient } = await import('@/lib/api-client');

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

const mockClearAuth = vi.fn();
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (selector: (s: { clearAuth: () => void }) => unknown) => selector({ clearAuth: mockClearAuth }),
}));

const mockBroadcastLogout = vi.fn();
vi.mock('@/lib/auth-broadcast', () => ({ broadcastLogout: () => mockBroadcastLogout() }));

const SUCCESS_RESPONSE = {
  data: { user: { id: 'u1', must_change_password: false } },
  error: null,
  meta: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
});

async function fillAndSubmit(overrides: Partial<{ current: string; next: string; confirm: string }> = {}) {
  fireEvent.change(screen.getByLabelText('Current password'), {
    target: { value: overrides.current ?? 'OldPassword1!' },
  });
  fireEvent.change(screen.getByLabelText('New password'), {
    target: { value: overrides.next ?? 'NewPassword1!' },
  });
  fireEvent.change(screen.getByLabelText('Confirm new password'), {
    target: { value: overrides.confirm ?? 'NewPassword1!' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
}

describe('ChangePasswordPage success flow', () => {
  it('calls the change-password API exactly once', async () => {
    vi.mocked(apiClient).mockResolvedValue(SUCCESS_RESPONSE);
    render(<ChangePasswordPage />);

    await fillAndSubmit();

    await waitFor(() => expect(apiClient).toHaveBeenCalledTimes(1));
    expect(apiClient).toHaveBeenCalledWith(
      '/api/auth/change-password',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('clears auth state and broadcasts logout on success', async () => {
    vi.mocked(apiClient).mockResolvedValue(SUCCESS_RESPONSE);
    render(<ChangePasswordPage />);

    await fillAndSubmit();

    await waitFor(() => expect(mockClearAuth).toHaveBeenCalledTimes(1));
    expect(mockBroadcastLogout).toHaveBeenCalledTimes(1);
  });

  it('shows a success message telling the user to sign in again', async () => {
    vi.mocked(apiClient).mockResolvedValue(SUCCESS_RESPONSE);
    render(<ChangePasswordPage />);

    await fillAndSubmit();

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Password updated. Please sign in again.'));
  });

  it('redirects with router.replace to /login, not the branch dashboard', async () => {
    vi.mocked(apiClient).mockResolvedValue(SUCCESS_RESPONSE);
    render(<ChangePasswordPage />);

    await fillAndSubmit();

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    expect(mockReplace).not.toHaveBeenCalledWith(expect.stringContaining('/branch'));
  });

  it('appends a safe stored return path as ?returnTo= on the /login redirect', async () => {
    sessionStorage.setItem('pc_redirect_after_password_change', '/branch/terminal');
    vi.mocked(apiClient).mockResolvedValue(SUCCESS_RESPONSE);
    render(<ChangePasswordPage />);

    await fillAndSubmit();

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login?returnTo=%2Fbranch%2Fterminal'));
  });

  it('ignores an unsafe stored return path and redirects to plain /login', async () => {
    sessionStorage.setItem('pc_redirect_after_password_change', '//evil.com');
    vi.mocked(apiClient).mockResolvedValue(SUCCESS_RESPONSE);
    render(<ChangePasswordPage />);

    await fillAndSubmit();

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
  });
});

describe('ChangePasswordPage error flow', () => {
  it('shows the server error and does not redirect on a wrong current password', async () => {
    vi.mocked(apiClient).mockResolvedValue({
      data: null,
      error: { code: 'INVALID_PASSWORD', message: 'Current password is incorrect' },
      meta: null,
    });
    render(<ChangePasswordPage />);

    await fillAndSubmit({ current: 'WrongPassword1!' });

    await waitFor(() => expect(screen.getByText('Current password is incorrect')).toBeInTheDocument());
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockClearAuth).not.toHaveBeenCalled();
  });

  it('regression: a confirmed-dead session (SESSION_EXPIRED) clears auth and redirects to /login instead of stranding the user on the form', async () => {
    vi.mocked(apiClient).mockResolvedValue({
      data: null,
      error: { code: 'SESSION_EXPIRED', message: 'Session expired. Please sign in again.' },
      meta: null,
    });
    render(<ChangePasswordPage />);

    await fillAndSubmit();

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    expect(mockClearAuth).toHaveBeenCalledTimes(1);
    expect(mockBroadcastLogout).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Session expired. Please sign in again.')).not.toBeInTheDocument();
  });

  it('does not call the API when passwords do not match (client-side validation)', async () => {
    render(<ChangePasswordPage />);

    await fillAndSubmit({ confirm: 'SomethingElse1!' });

    await waitFor(() => expect(screen.getByText('Passwords do not match')).toBeInTheDocument());
    expect(apiClient).not.toHaveBeenCalled();
  });

  it('does not call the API when the new password fails the strength rules', async () => {
    render(<ChangePasswordPage />);

    await fillAndSubmit({ next: 'weak', confirm: 'weak' });

    await waitFor(() => expect(apiClient).not.toHaveBeenCalled());
  });

  it('disables the submit button while a request is in flight, preventing double submission', async () => {
    let resolveRequest: (value: typeof SUCCESS_RESPONSE) => void = () => {};
    vi.mocked(apiClient).mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    render(<ChangePasswordPage />);

    await fillAndSubmit();

    await waitFor(() => expect(screen.getByRole('button')).toBeDisabled());
    expect(apiClient).toHaveBeenCalledTimes(1);

    resolveRequest(SUCCESS_RESPONSE);
  });
});
