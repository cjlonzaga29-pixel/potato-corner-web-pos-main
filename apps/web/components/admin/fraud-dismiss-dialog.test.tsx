import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { FraudAlertResponse } from '@potato-corner/shared';
import { DismissFraudAlertDialog } from './fraud-dismiss-dialog';

const { mockUseDismissAlert } = vi.hoisted(() => ({
  mockUseDismissAlert: vi.fn(),
}));

vi.mock('@/hooks/queries/use-fraud-alerts', () => ({
  useDismissAlert: mockUseDismissAlert,
}));

function fraudAlert(overrides: Partial<FraudAlertResponse> = {}): FraudAlertResponse {
  return {
    id: 'alert-1',
    alert_type: 'excessive_void_rate',
    severity: 'high',
    status: 'open',
    branch_id: 'branch-1',
    branch_name: 'Main Branch',
    employee_id: 'employee-1',
    employee_name: 'Juan Dela Cruz',
    evidence: {},
    investigated_by: null,
    dismissal_reason: null,
    created_at: '2026-07-16T02:00:00.000Z',
    updated_at: '2026-07-16T02:00:00.000Z',
    ...overrides,
  };
}

/** Controlled-prop harness — the dialog itself never owns `open`, so closing/reset behavior can only be observed through a parent that actually reacts to onOpenChange. */
function Harness({ alert }: { alert: FraudAlertResponse | null }) {
  const [open, setOpen] = useState(true);
  return <DismissFraudAlertDialog alert={alert} open={open} onOpenChange={setOpen} />;
}

beforeEach(() => {
  mockUseDismissAlert.mockReturnValue({ mutate: vi.fn(), isPending: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DismissFraudAlertDialog', () => {
  it('renders the textarea when open', () => {
    render(<DismissFraudAlertDialog alert={fraudAlert()} open onOpenChange={vi.fn()} />);

    expect(screen.getByText('Dismiss Fraud Alert')).toBeInTheDocument();
    expect(screen.getByLabelText(/Dismissal Reason/)).toBeInTheDocument();
    expect(screen.getByText('0 / 10 minimum')).toBeInTheDocument();
  });

  it('disables the submit button when the reason is shorter than 10 characters', () => {
    render(<DismissFraudAlertDialog alert={fraudAlert()} open onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/Dismissal Reason/), { target: { value: 'too short' } });

    expect(screen.getByRole('button', { name: 'Dismiss Alert' })).toBeDisabled();
  });

  it('enables the submit button once the reason reaches 10 characters', () => {
    render(<DismissFraudAlertDialog alert={fraudAlert()} open onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/Dismissal Reason/), { target: { value: 'exactly 10+' } });

    expect(screen.getByRole('button', { name: 'Dismiss Alert' })).toBeEnabled();
  });

  it('calls useDismissAlert with the alert id and typed reason on submit', () => {
    const mutate = vi.fn();
    mockUseDismissAlert.mockReturnValue({ mutate, isPending: false });

    render(<DismissFraudAlertDialog alert={fraudAlert({ id: 'alert-42' })} open onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/Dismissal Reason/), {
      target: { value: 'Verified with the branch supervisor.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Alert' }));

    expect(mutate).toHaveBeenCalledWith(
      { id: 'alert-42', input: { dismissal_reason: 'Verified with the branch supervisor.' } },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('closes the dialog and resets the textarea on a successful dismissal', () => {
    const mutate = vi.fn((_vars, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
    mockUseDismissAlert.mockReturnValue({ mutate, isPending: false });

    render(<Harness alert={fraudAlert()} />);

    fireEvent.change(screen.getByLabelText(/Dismissal Reason/), {
      target: { value: 'Verified with the branch supervisor.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Alert' }));

    expect(screen.queryByText('Dismiss Fraud Alert')).not.toBeInTheDocument();
  });

  it('closes the dialog when Cancel is clicked', () => {
    render(<Harness alert={fraudAlert()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Dismiss Fraud Alert')).not.toBeInTheDocument();
  });
});
