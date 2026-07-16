import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { PriceOverrideResponse } from '@potato-corner/shared';
import { DashboardPendingOverrides } from './dashboard-pending-overrides';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

afterEach(() => {
  cleanup();
});

function priceOverride(overrides: Partial<PriceOverrideResponse> = {}): PriceOverrideResponse {
  return {
    id: 'override-1',
    branch_id: 'branch-1',
    branch_name: 'Manila Branch',
    product_variant_id: 'variant-1',
    variant_name: 'Regular',
    product_name: 'Classic Potato',
    master_price: 65,
    requested_price: 75,
    status: 'pending',
    requested_by: 'user-1',
    requested_by_name: 'Juan Dela Cruz',
    request_reason: 'Local ingredient cost increase requires a branch-specific price adjustment.',
    reviewed_by: null,
    reviewed_by_name: null,
    reviewed_at: null,
    review_notes: null,
    effective_from: null,
    created_at: '2026-07-16T01:00:00.000Z',
    updated_at: '2026-07-16T01:00:00.000Z',
    ...overrides,
  };
}

describe('DashboardPendingOverrides', () => {
  it('renders skeleton rows when isLoading is true', () => {
    const { container } = render(<DashboardPendingOverrides overrides={undefined} isLoading={true} />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders an empty state when overrides is empty', () => {
    render(<DashboardPendingOverrides overrides={[]} isLoading={false} />);
    expect(screen.getByText('No pending price overrides')).toBeInTheDocument();
  });

  it('renders product_name, master_price, and requested_price for each override', () => {
    render(<DashboardPendingOverrides overrides={[priceOverride()]} isLoading={false} />);
    expect(screen.getByText(/Classic Potato/)).toBeInTheDocument();
    expect(screen.getByText('₱65.00')).toBeInTheDocument();
    expect(screen.getByText('₱75.00')).toBeInTheDocument();
  });

  it('renders a "View all" link', () => {
    render(<DashboardPendingOverrides overrides={[]} isLoading={false} />);
    const link = screen.getByText('View all');
    expect(link).toBeInTheDocument();
    expect(link.closest('a')).toHaveAttribute('href', '/admin/approvals/price-overrides');
  });
});
