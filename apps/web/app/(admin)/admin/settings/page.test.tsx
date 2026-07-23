import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import SettingsPage from './page';

const { mockPush, mockUsePathname, mockUseSearchParams } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUsePathname: vi.fn(() => '/admin/settings'),
  mockUseSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: mockUsePathname,
  useSearchParams: mockUseSearchParams,
}));

/**
 * Real Radix Tabs uses pointer-event-based activation with no jsdom-friendly
 * interaction path without @testing-library/user-event (same reasoning as
 * expenses/page.test.tsx's Select mock) — stand it up as plain, always
 * click-responsive elements that keep the same ARIA roles.
 */
vi.mock('@/components/ui/tabs', () => {
  const TabsContext = React.createContext<{ value?: string; onValueChange?: (value: string) => void }>({});

  function Tabs({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children?: React.ReactNode;
  }) {
    return <TabsContext.Provider value={{ value, onValueChange }}>{children}</TabsContext.Provider>;
  }
  function TabsList({ children }: { children?: React.ReactNode }) {
    return <div role="tablist">{children}</div>;
  }
  function TabsTrigger({ value, children }: { value: string; children?: React.ReactNode }) {
    const ctx = React.useContext(TabsContext);
    return (
      <button type="button" role="tab" aria-selected={ctx.value === value} onClick={() => ctx.onValueChange?.(value)}>
        {children}
      </button>
    );
  }
  function TabsContent({ value, children }: { value: string; children?: React.ReactNode }) {
    const ctx = React.useContext(TabsContext);
    if (ctx.value !== value) return null;
    return <div>{children}</div>;
  }
  return { Tabs, TabsList, TabsTrigger, TabsContent };
});

vi.mock('@/components/settings/security-policy-section', () => ({
  SecurityPolicySection: () => <div>Security Section Content</div>,
}));
vi.mock('@/components/settings/notification-preferences-section', () => ({
  NotificationPreferencesSection: () => <div>Notifications Section Content</div>,
}));
vi.mock('@/components/settings/receipt-templates-section', () => ({
  ReceiptTemplatesSection: () => <div>Receipts Section Content</div>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockUseSearchParams.mockReturnValue(new URLSearchParams());
});

describe('SettingsPage', () => {
  it('renders 3 tabs', () => {
    render(<SettingsPage />);

    expect(screen.getByRole('tab', { name: 'Security' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Receipt Templates' })).toBeInTheDocument();
  });

  it('default tab is Security', () => {
    render(<SettingsPage />);

    expect(screen.getByRole('tab', { name: 'Security', selected: true })).toBeInTheDocument();
  });

  it('tab change updates URL search param', () => {
    render(<SettingsPage />);

    fireEvent.click(screen.getByRole('tab', { name: 'Notifications' }));

    expect(mockPush).toHaveBeenCalledWith('/admin/settings?tab=notifications', { scroll: false });
  });

  it('renders correct section per tab', () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('tab=receipts'));

    render(<SettingsPage />);

    expect(screen.getByText('Receipts Section Content')).toBeInTheDocument();
  });
});
