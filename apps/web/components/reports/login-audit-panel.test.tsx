import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { AuditLogReportRow } from '@/hooks/queries/use-audit-log-report';
import { LoginAuditPanel } from './login-audit-panel';

const { mockUseAuditLogReport, mockUseRequestExport } = vi.hoisted(() => ({
  mockUseAuditLogReport: vi.fn(),
  mockUseRequestExport: vi.fn(() => ({ mutate: vi.fn() })),
}));

vi.mock('@/hooks/queries/use-audit-log-report', () => ({
  useAuditLogReport: mockUseAuditLogReport,
}));

vi.mock('@/hooks/queries/use-reports', () => ({
  useRequestExport: mockUseRequestExport,
}));

vi.mock('@/components/reports/report-filter-bar', () => ({
  ReportFilterBar: () => <div data-testid="report-filter-bar" />,
}));

function row(overrides: Partial<AuditLogReportRow> = {}): AuditLogReportRow {
  return {
    id: 'log-1',
    created_at: '2026-07-30T08:00:00.000Z',
    action: 'LOGIN_SUCCESS',
    actor_id: 'user-1',
    actor_role: 'staff',
    ip_address: '127.0.0.1',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LoginAuditPanel — pagination', () => {
  it('requests page 1 with a 25-row page size by default (not the old fixed limit of 100)', () => {
    mockUseAuditLogReport.mockReturnValue({ data: { data: [], total: 0 }, isLoading: false, isError: false, refetch: vi.fn() });

    render(<LoginAuditPanel />);

    expect(mockUseAuditLogReport).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 25 }));
  });

  it('shows pagination controls and requests the next page of results when there are more rows than fit on one page', () => {
    mockUseAuditLogReport.mockReturnValue({
      data: { data: [row()], total: 40 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<LoginAuditPanel />);

    expect(screen.getByText(/page 1 of 2/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));

    expect(mockUseAuditLogReport).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, limit: 25 }));
  });
});
