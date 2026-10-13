import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ProductOptionGroupResponse } from '@potato-corner/shared';
import ProductOptionsPage from './page';

const { mockUseProductOptionGroups, mockPush } = vi.hoisted(() => ({
  mockUseProductOptionGroups: vi.fn(),
  mockPush: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/queries/use-product-options', () => ({
  useProductOptionGroups: mockUseProductOptionGroups,
}));

function group(overrides: Partial<ProductOptionGroupResponse> = {}): ProductOptionGroupResponse {
  return {
    id: 'group-1',
    code: 'flavor',
    name: 'Flavor',
    description: null,
    pos_button_label: null,
    selection_type: 'SINGLE',
    min_selections: 0,
    max_selections: 1,
    required: false,
    is_active: true,
    sort_order: 0,
    option_count: 3,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderPage(groups: ProductOptionGroupResponse[] = [group()]) {
  mockUseProductOptionGroups.mockReturnValue({
    data: { option_groups: groups, total: groups.length, page: 1, limit: 25 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  return render(<ProductOptionsPage />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// POS-PERF-P35 — Product Options management moved to Supervisor; this page
// is read-only reporting for Admin now (View instead of Edit, no Delete,
// no New Option Group button).
describe('ProductOptionsPage — Admin read-only (POS-PERF-P35)', () => {
  it('shows a View action and no Delete action, and no create button', () => {
    renderPage();

    expect(screen.getByText(/managed by Supervisor now/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View Flavor' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit flavor/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete flavor/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new option group/i })).not.toBeInTheDocument();
  });
});
