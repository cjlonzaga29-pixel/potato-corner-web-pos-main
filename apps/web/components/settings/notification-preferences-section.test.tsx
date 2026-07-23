import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { NotificationPreferencesSection } from './notification-preferences-section';

const { mockUseNotificationPreferences, mockUseUpdateNotificationPreferences } = vi.hoisted(() => ({
  mockUseNotificationPreferences: vi.fn(),
  mockUseUpdateNotificationPreferences: vi.fn(),
}));

vi.mock('@/hooks/queries/use-settings', () => ({
  useNotificationPreferences: mockUseNotificationPreferences,
  useUpdateNotificationPreferences: mockUseUpdateNotificationPreferences,
}));

/** Flat, always-rendered list — same approach as expenses/page.test.tsx for the real Radix Select. */
vi.mock('@/components/ui/select', () => {
  function Select({ disabled, children }: { disabled?: boolean; children?: React.ReactNode }) {
    return <div data-disabled={disabled ? 'true' : 'false'}>{children}</div>;
  }
  function SelectTrigger({ children }: { id?: string; children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectValue() {
    return null;
  }
  function SelectContent({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  function SelectItem({ children }: { value: string; children?: React.ReactNode }) {
    return <>{children}</>;
  }
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

const PREFERENCES = {
  emailDigestEnabled: true,
  emailDigestFrequency: 'daily' as const,
  alertFraud: true,
  alertLowStock: true,
  alertCashVariance: true,
  alertVoidRequests: true,
  dndEnabled: false,
  dndStartHour: 22,
  dndEndHour: 7,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NotificationPreferencesSection', () => {
  it('renders all toggles', () => {
    mockUseNotificationPreferences.mockReturnValue({ data: PREFERENCES, isLoading: false, isError: false });
    mockUseUpdateNotificationPreferences.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<NotificationPreferencesSection />);

    expect(screen.getByLabelText('Email digest')).toBeInTheDocument();
    expect(screen.getByLabelText('Fraud alerts')).toBeInTheDocument();
    expect(screen.getByLabelText('Low stock alerts')).toBeInTheDocument();
    expect(screen.getByLabelText('Cash variance alerts')).toBeInTheDocument();
    expect(screen.getByLabelText('Void request alerts')).toBeInTheDocument();
    expect(screen.getByLabelText('Do not disturb')).toBeInTheDocument();
  });

  it('frequency select updates when digest disabled', () => {
    mockUseNotificationPreferences.mockReturnValue({
      data: { ...PREFERENCES, emailDigestEnabled: false },
      isLoading: false,
      isError: false,
    });
    mockUseUpdateNotificationPreferences.mockReturnValue({ mutate: vi.fn(), isPending: false });

    const { container } = render(<NotificationPreferencesSection />);

    const frequencySelect = container.querySelector('[data-disabled]');
    expect(frequencySelect).toHaveAttribute('data-disabled', 'true');
  });

  it('DND hour inputs disabled when DND toggle off', () => {
    mockUseNotificationPreferences.mockReturnValue({ data: { ...PREFERENCES, dndEnabled: false }, isLoading: false, isError: false });
    mockUseUpdateNotificationPreferences.mockReturnValue({ mutate: vi.fn(), isPending: false });

    const { container } = render(<NotificationPreferencesSection />);

    const disabledSelects = container.querySelectorAll('[data-disabled="true"]');
    expect(disabledSelects.length).toBeGreaterThanOrEqual(2);
  });
});
