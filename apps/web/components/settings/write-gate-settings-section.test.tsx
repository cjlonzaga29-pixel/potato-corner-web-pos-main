import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import { WriteGateSettingsSection } from './write-gate-settings-section';

const { mockUseWriteGate, mockUseUpdateWriteGate } = vi.hoisted(() => ({
  mockUseWriteGate: vi.fn(),
  mockUseUpdateWriteGate: vi.fn(),
}));

vi.mock('@/hooks/queries/use-settings', () => ({
  useWriteGate: mockUseWriteGate,
  useUpdateWriteGate: mockUseUpdateWriteGate,
}));

const OPEN_STATE = { enabled: false, reason: null, updatedAt: null, updatedBy: null, activeGatedRequests: 0 };
const CLOSED_STATE = {
  enabled: true,
  reason: 'P18 release deploy',
  updatedAt: '2026-10-06T14:00:00.000Z',
  updatedBy: 'admin-1',
  activeGatedRequests: 2,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WriteGateSettingsSection', () => {
  it('shows Open status and a disabled Close Gate button until a reason is typed', () => {
    mockUseWriteGate.mockReturnValue({ data: OPEN_STATE, isLoading: false, isError: false });
    const mutate = vi.fn();
    mockUseUpdateWriteGate.mockReturnValue({ mutate, isPending: false });

    render(<WriteGateSettingsSection />);

    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Gate' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Reason (required to close)'), { target: { value: 'Maintenance window' } });
    expect(screen.getByRole('button', { name: 'Close Gate' })).toBeEnabled();
  });

  it('closing requires confirming the dialog before calling the mutation', () => {
    mockUseWriteGate.mockReturnValue({ data: OPEN_STATE, isLoading: false, isError: false });
    const mutate = vi.fn();
    mockUseUpdateWriteGate.mockReturnValue({ mutate, isPending: false });

    render(<WriteGateSettingsSection />);

    fireEvent.change(screen.getByLabelText('Reason (required to close)'), { target: { value: 'Maintenance window' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close Gate' }));

    expect(mutate).not.toHaveBeenCalled();

    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close Gate' }));

    expect(mutate).toHaveBeenCalledWith({ enabled: true, reason: 'Maintenance window' }, expect.anything());
  });

  it('shows Closed status, the reason, the active request count, and a Reopen Gate button', () => {
    mockUseWriteGate.mockReturnValue({ data: CLOSED_STATE, isLoading: false, isError: false });
    const mutate = vi.fn();
    mockUseUpdateWriteGate.mockReturnValue({ mutate, isPending: false });

    render(<WriteGateSettingsSection />);

    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.getByText('Reason: P18 release deploy')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reopen Gate' }));
    expect(mutate).toHaveBeenCalledWith({ enabled: false });
  });

  it('shows an error message when the gate state fails to load', () => {
    mockUseWriteGate.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    mockUseUpdateWriteGate.mockReturnValue({ mutate: vi.fn(), isPending: false });

    render(<WriteGateSettingsSection />);

    expect(screen.getByText('Failed to load write-gate state.')).toBeInTheDocument();
  });
});
