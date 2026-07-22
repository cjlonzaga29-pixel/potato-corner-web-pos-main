import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TwoFactorSection } from './two-factor-section';

const {
  mockUse2FAStatus,
  mockUseEnroll2FA,
  mockUseConfirm2FA,
  mockUseDisable2FA,
  mockUseRegenerateBackupCodes,
} = vi.hoisted(() => ({
  mockUse2FAStatus: vi.fn(),
  mockUseEnroll2FA: vi.fn(),
  mockUseConfirm2FA: vi.fn(),
  mockUseDisable2FA: vi.fn(),
  mockUseRegenerateBackupCodes: vi.fn(),
}));

vi.mock('@/hooks/queries/use-2fa', () => ({
  use2FAStatus: mockUse2FAStatus,
  useEnroll2FA: mockUseEnroll2FA,
  useConfirm2FA: mockUseConfirm2FA,
  useDisable2FA: mockUseDisable2FA,
  useRegenerateBackupCodes: mockUseRegenerateBackupCodes,
}));

function defaultMutation(overrides: Partial<Record<string, unknown>> = {}) {
  return { mutateAsync: vi.fn(), isPending: false, data: undefined, reset: vi.fn(), ...overrides };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TwoFactorSection', () => {
  it('renders "Enable 2FA" button when not enabled', () => {
    mockUse2FAStatus.mockReturnValue({ data: { enabled: false, enrolledAt: null }, isLoading: false, isError: false });
    mockUseEnroll2FA.mockReturnValue(defaultMutation());
    mockUseConfirm2FA.mockReturnValue(defaultMutation());
    mockUseDisable2FA.mockReturnValue(defaultMutation());
    mockUseRegenerateBackupCodes.mockReturnValue(defaultMutation());

    render(<TwoFactorSection />);

    expect(screen.getByRole('button', { name: 'Enable 2FA' })).toBeInTheDocument();
  });

  it('renders "Enabled" badge when enabled', () => {
    mockUse2FAStatus.mockReturnValue({
      data: { enabled: true, enrolledAt: '2026-07-20T00:00:00.000Z' },
      isLoading: false,
      isError: false,
    });
    mockUseEnroll2FA.mockReturnValue(defaultMutation());
    mockUseConfirm2FA.mockReturnValue(defaultMutation());
    mockUseDisable2FA.mockReturnValue(defaultMutation());
    mockUseRegenerateBackupCodes.mockReturnValue(defaultMutation());

    render(<TwoFactorSection />);

    expect(screen.getByText(/2FA Enabled since/)).toBeInTheDocument();
  });

  it('opens the setup dialog on Enable click', () => {
    mockUse2FAStatus.mockReturnValue({ data: { enabled: false, enrolledAt: null }, isLoading: false, isError: false });
    mockUseEnroll2FA.mockReturnValue(defaultMutation());
    mockUseConfirm2FA.mockReturnValue(defaultMutation());
    mockUseDisable2FA.mockReturnValue(defaultMutation());
    mockUseRegenerateBackupCodes.mockReturnValue(defaultMutation());

    render(<TwoFactorSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Enable 2FA' }));

    expect(screen.getByText('Set up Two-Factor Authentication')).toBeInTheDocument();
  });

  it('shows the QR code and secret in the setup dialog', () => {
    mockUse2FAStatus.mockReturnValue({ data: { enabled: false, enrolledAt: null }, isLoading: false, isError: false });
    mockUseEnroll2FA.mockReturnValue(
      defaultMutation({ data: { qrCodeDataUrl: 'data:image/png;base64,abc', secret: 'SECRET123' } }),
    );
    mockUseConfirm2FA.mockReturnValue(defaultMutation());
    mockUseDisable2FA.mockReturnValue(defaultMutation());
    mockUseRegenerateBackupCodes.mockReturnValue(defaultMutation());

    render(<TwoFactorSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Enable 2FA' }));

    expect(screen.getByAltText('2FA QR code')).toHaveAttribute('src', 'data:image/png;base64,abc');
    expect(screen.getByText('SECRET123')).toBeInTheDocument();
  });

  it('advances to the backup codes step on a valid code confirm', async () => {
    mockUse2FAStatus.mockReturnValue({ data: { enabled: false, enrolledAt: null }, isLoading: false, isError: false });
    mockUseEnroll2FA.mockReturnValue(
      defaultMutation({ data: { qrCodeDataUrl: 'data:image/png;base64,abc', secret: 'SECRET123' } }),
    );
    mockUseConfirm2FA.mockReturnValue(
      defaultMutation({ mutateAsync: vi.fn().mockResolvedValue({ backupCodes: ['CODE0000A', 'CODE0000B'] }) }),
    );
    mockUseDisable2FA.mockReturnValue(defaultMutation());
    mockUseRegenerateBackupCodes.mockReturnValue(defaultMutation());

    render(<TwoFactorSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Enable 2FA' }));
    fireEvent.change(screen.getByLabelText('Enter the 6-digit code from your app'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByText('Save your backup codes')).toBeInTheDocument();
    expect(screen.getByText('CODE0000A')).toBeInTheDocument();
  });

  it('opens the disable confirmation dialog on Disable click', () => {
    mockUse2FAStatus.mockReturnValue({
      data: { enabled: true, enrolledAt: '2026-07-20T00:00:00.000Z' },
      isLoading: false,
      isError: false,
    });
    mockUseEnroll2FA.mockReturnValue(defaultMutation());
    mockUseConfirm2FA.mockReturnValue(defaultMutation());
    mockUseDisable2FA.mockReturnValue(defaultMutation());
    mockUseRegenerateBackupCodes.mockReturnValue(defaultMutation());

    render(<TwoFactorSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Disable 2FA' }));

    expect(screen.getByText('Disable Two-Factor Authentication')).toBeInTheDocument();
  });
});
