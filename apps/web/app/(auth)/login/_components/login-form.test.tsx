import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { LoginForm } from './login-form';
import { ApiRequestError } from '@/hooks/queries/use-2fa';

const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockSearchParams,
}));

const mockLogin = vi.fn();
const mockCompleteLogin = vi.fn();
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ login: mockLogin, completeLogin: mockCompleteLogin }),
}));

const mockVerifyLoginMutateAsync = vi.fn();
const mockVerifyBackupCodeMutateAsync = vi.fn();
vi.mock('@/hooks/queries/use-2fa', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/queries/use-2fa')>('@/hooks/queries/use-2fa');
  return {
    ...actual,
    useVerify2FALogin: () => ({ mutateAsync: mockVerifyLoginMutateAsync, isPending: false }),
    useVerify2FABackupCode: () => ({ mutateAsync: mockVerifyBackupCodeMutateAsync, isPending: false }),
  };
});

const STAFF_USER = {
  id: 'u1',
  role: 'staff' as const,
  email: 'staff@potatocorner.test',
  first_name: 'Juan',
  last_name: 'Dela Cruz',
  branch_ids: ['b1'],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockSearchParams = new URLSearchParams();
});

async function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'staff@potatocorner.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginForm post-login redirect', () => {
  it('redirects to the role dashboard when there is no returnTo param', async () => {
    mockLogin.mockResolvedValue({ challengeRequired: false, user: STAFF_USER });
    render(<LoginForm />);

    await fillAndSubmit();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/branch/terminal'));
  });

  it('redirects to a valid same-origin returnTo instead of the role dashboard', async () => {
    mockLogin.mockResolvedValue({ challengeRequired: false, user: STAFF_USER });
    mockSearchParams = new URLSearchParams({ returnTo: '/receipts/12345' });
    render(<LoginForm />);

    await fillAndSubmit();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/receipts/12345'));
  });

  it.each([
    ['//evil.com', 'protocol-relative'],
    ['/\\evil.com', 'backslash protocol-relative'],
    ['https://evil.com', 'absolute URL'],
    ['javascript:alert(1)', 'javascript: URI'],
    ['evil.com', 'not path-rooted'],
  ])('falls back to the role dashboard when returnTo (%s) is a %s open-redirect attempt', async (unsafeValue) => {
    mockLogin.mockResolvedValue({ challengeRequired: false, user: STAFF_USER });
    mockSearchParams = new URLSearchParams({ returnTo: unsafeValue });
    render(<LoginForm />);

    await fillAndSubmit();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/branch/terminal'));
  });
});

describe('LoginForm 2FA challenge', () => {
  it('renders the TOTP challenge screen when login returns challenge_required', async () => {
    mockLogin.mockResolvedValue({ challengeRequired: true, challengeToken: 'chal-1', expiresIn: 300 });
    render(<LoginForm />);

    await fillAndSubmit();

    await waitFor(() => expect(screen.getByText('Two-Factor Authentication')).toBeInTheDocument());
    expect(screen.getByLabelText('Authentication code')).toBeInTheDocument();
  });

  it('submits the verify-login mutation with the challenge token, code, and device id', async () => {
    mockLogin.mockResolvedValue({ challengeRequired: true, challengeToken: 'chal-1', expiresIn: 300 });
    mockVerifyLoginMutateAsync.mockResolvedValue({ access_token: 'at-1', user: STAFF_USER });
    mockCompleteLogin.mockReturnValue(STAFF_USER);
    render(<LoginForm />);
    await fillAndSubmit();
    await waitFor(() => expect(screen.getByLabelText('Authentication code')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() =>
      expect(mockVerifyLoginMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ challengeToken: 'chal-1', totpCode: '123456' }),
      ),
    );
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/branch/terminal'));
  });

  it('shows an error message when the TOTP code is invalid', async () => {
    mockLogin.mockResolvedValue({ challengeRequired: true, challengeToken: 'chal-1', expiresIn: 300 });
    mockVerifyLoginMutateAsync.mockRejectedValue(new ApiRequestError('Invalid authentication code', 'INVALID_2FA_CODE'));
    render(<LoginForm />);
    await fillAndSubmit();
    await waitFor(() => expect(screen.getByLabelText('Authentication code')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(screen.getByText('Invalid authentication code')).toBeInTheDocument());
  });

  it('toggles to the backup code screen and back', async () => {
    mockLogin.mockResolvedValue({ challengeRequired: true, challengeToken: 'chal-1', expiresIn: 300 });
    render(<LoginForm />);
    await fillAndSubmit();
    await waitFor(() => expect(screen.getByLabelText('Authentication code')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Use backup code instead'));
    expect(screen.getByLabelText('Backup code')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Use authentication code instead'));
    expect(screen.getByLabelText('Authentication code')).toBeInTheDocument();
  });

  it('displays a countdown of the challenge expiry', async () => {
    mockLogin.mockResolvedValue({ challengeRequired: true, challengeToken: 'chal-1', expiresIn: 125 });
    render(<LoginForm />);
    await fillAndSubmit();

    await waitFor(() => expect(screen.getByText(/Challenge expires in 2:05/)).toBeInTheDocument());
  });
});
