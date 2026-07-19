import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { LoginForm } from './login-form';

const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockSearchParams,
}));

const mockLogin = vi.fn();
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ login: mockLogin }),
}));

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
    mockLogin.mockResolvedValue(STAFF_USER);
    render(<LoginForm />);

    await fillAndSubmit();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/terminal'));
  });

  it('redirects to a valid same-origin returnTo instead of the role dashboard', async () => {
    mockLogin.mockResolvedValue(STAFF_USER);
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
    mockLogin.mockResolvedValue(STAFF_USER);
    mockSearchParams = new URLSearchParams({ returnTo: unsafeValue });
    render(<LoginForm />);

    await fillAndSubmit();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/terminal'));
  });
});
