import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ProductRequestResponse } from '@potato-corner/shared';
import { DashboardPendingRequests } from './dashboard-pending-requests';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

afterEach(() => {
  cleanup();
});

function productRequest(overrides: Partial<ProductRequestResponse> = {}): ProductRequestResponse {
  return {
    id: 'request-1',
    branch_id: 'branch-1',
    branch_name: 'Manila Branch',
    requested_by: 'user-1',
    requested_by_name: 'Juan Dela Cruz',
    proposed_name: 'Cheese Overload',
    proposed_description: null,
    proposed_category: null,
    proposed_variants: [],
    proposed_flavors: [],
    proposed_recipes: [],
    request_reason: 'Customer demand for a new flavor variant based on regional taste testing feedback.',
    status: 'pending',
    reviewed_by: null,
    reviewed_by_name: null,
    reviewed_at: null,
    review_notes: null,
    created_product_id: null,
    created_at: '2026-07-16T01:00:00.000Z',
    updated_at: '2026-07-16T01:00:00.000Z',
    ...overrides,
  };
}

describe('DashboardPendingRequests', () => {
  it('renders skeleton rows when isLoading is true', () => {
    const { container } = render(<DashboardPendingRequests requests={undefined} isLoading={true} />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders an empty state when requests is empty', () => {
    render(<DashboardPendingRequests requests={[]} isLoading={false} />);
    expect(screen.getByText('No pending product requests')).toBeInTheDocument();
  });

  it('renders branch_name and proposed_name for each request', () => {
    render(<DashboardPendingRequests requests={[productRequest()]} isLoading={false} />);
    expect(screen.getByText('Cheese Overload')).toBeInTheDocument();
    expect(screen.getByText(/Manila Branch/)).toBeInTheDocument();
  });

  it('renders a "View all" link', () => {
    render(<DashboardPendingRequests requests={[]} isLoading={false} />);
    const link = screen.getByText('View all');
    expect(link).toBeInTheDocument();
    expect(link.closest('a')).toHaveAttribute('href', '/admin/approvals/product-requests');
  });
});
