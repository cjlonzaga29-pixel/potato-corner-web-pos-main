import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { AuditLogResponse } from '@potato-corner/shared';
import BranchActivityLogsPage from './page';

const { mockUseAuditLogs } = vi.hoisted(() => ({
  mockUseAuditLogs: vi.fn(),
}));

vi.mock('@/hooks/queries/use-audit-logs', () => ({
  useAuditLogs: mockUseAuditLogs,
}));

function log(overrides: Partial<AuditLogResponse> = {}): AuditLogResponse {
  return {
    id: 'log-1',
    action: 'SHIFT_OPENED',
    entity_type: 'shift',
    entity_id: 'shift-1',
    actor_id: 'user-1',
    actor_role: 'staff',
    branch_id: 'branch-1',
    before_state: null,
    after_state: null,
    ip_address: '127.0.0.1',
    created_at: '2026-07-30T08:00:00.000Z',
    ...overrides,
  } as AuditLogResponse;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BranchActivityLogsPage — pagination', () => {
  it('requests page 1 with a 25-row page size by default (not the old fixed limit of 50)', () => {
    mockUseAuditLogs.mockReturnValue({ data: { logs: [], total: 0 }, isLoading: false, isError: false, refetch: vi.fn() });

    render(<BranchActivityLogsPage />);

    expect(mockUseAuditLogs).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 25 }));
  });

  it('shows pagination controls and requests the next page when there are more rows than fit on one page', () => {
    mockUseAuditLogs.mockReturnValue({
      data: { logs: [log()], total: 60 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<BranchActivityLogsPage />);

    expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));

    expect(mockUseAuditLogs).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, limit: 25 }));
  });
});
