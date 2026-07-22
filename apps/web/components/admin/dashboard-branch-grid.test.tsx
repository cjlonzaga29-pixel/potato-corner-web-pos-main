import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { BranchResponse } from '@potato-corner/shared';
import { DashboardBranchGrid } from './dashboard-branch-grid';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useAllBranchStats: () => ({ data: undefined, isLoading: false, isError: false }),
}));

afterEach(() => {
  cleanup();
});

function branch(overrides: Partial<BranchResponse> = {}): BranchResponse {
  return {
    id: 'branch-1',
    name: 'Manila Branch',
    code: 'PC-MNL-001',
    address: '123 Rizal Ave',
    city: 'Manila',
    gpsLatitude: 14.5995,
    gpsLongitude: 120.9842,
    gpsRadiusMeters: 100,
    status: 'active',
    gcashQrUrl: null,
    gcashQrKey: null,
    activeSupervisorCount: 1,
    activeStaffCount: 5,
    currentStatusLabel: 'Active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('DashboardBranchGrid', () => {
  it('renders skeleton cards when isLoading is true', () => {
    const { container } = render(<DashboardBranchGrid branches={undefined} flaggedBranchIds={new Set()} isLoading={true} />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders an empty state when branches is empty', () => {
    render(<DashboardBranchGrid branches={[]} flaggedBranchIds={new Set()} isLoading={false} />);
    expect(screen.getByText('No branches configured')).toBeInTheDocument();
  });

  it('renders branch name, code, and status badge per branch', () => {
    render(
      <DashboardBranchGrid
        branches={[branch({ id: 'branch-1', name: 'Manila Branch', code: 'PC-MNL-001', status: 'active' })]}
        flaggedBranchIds={new Set()}
        isLoading={false}
      />,
    );

    expect(screen.getByText('Manila Branch')).toBeInTheDocument();
    expect(screen.getByText('PC-MNL-001')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders a flagged warning when the branch id is in flaggedBranchIds', () => {
    render(
      <DashboardBranchGrid
        branches={[branch({ id: 'branch-1' })]}
        flaggedBranchIds={new Set(['branch-1'])}
        isLoading={false}
      />,
    );

    expect(screen.getByText('Shift flagged')).toBeInTheDocument();
  });

  it('does not render a flagged warning when the branch id is not in flaggedBranchIds', () => {
    render(
      <DashboardBranchGrid
        branches={[branch({ id: 'branch-1' })]}
        flaggedBranchIds={new Set(['branch-2'])}
        isLoading={false}
      />,
    );

    expect(screen.queryByText('Shift flagged')).not.toBeInTheDocument();
  });
});
