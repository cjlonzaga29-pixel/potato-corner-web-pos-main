import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ProductOptionGroupDetailResponse } from '@potato-corner/shared';
import ProductOptionGroupDetailPage from './page';

const { mockUseProductOptionGroup } = vi.hoisted(() => ({
  mockUseProductOptionGroup: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/hooks/queries/use-product-options', () => ({
  useProductOptionGroup: mockUseProductOptionGroup,
}));

function group(overrides: Partial<ProductOptionGroupDetailResponse> = {}): ProductOptionGroupDetailResponse {
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
    option_count: 1,
    options: [
      {
        id: 'option-1',
        option_group_id: 'group-1',
        code: 'cheese',
        name: 'Cheese',
        price_adjustment: 0,
        image_url: null,
        is_active: true,
        sort_order: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** React's `use()` only unwraps synchronously if the thenable is already flagged fulfilled — mirrors Next.js's cached params promise. */
function resolvedParams(groupId: string): Promise<{ groupId: string }> {
  const promise = Promise.resolve({ groupId }) as Promise<{ groupId: string }> & { status?: string; value?: { groupId: string } };
  promise.status = 'fulfilled';
  promise.value = { groupId };
  return promise;
}

// POS-PERF-P35 — Product Options management moved to Supervisor; this page
// is read-only reporting for Admin now (no POS Button Label form, no
// Add/Edit Option controls).
describe('ProductOptionGroupDetailPage — Admin read-only (POS-PERF-P35)', () => {
  it('shows the managed-elsewhere banner, group info, and option list with no write controls', () => {
    mockUseProductOptionGroup.mockReturnValue({ data: group(), isLoading: false });

    render(<ProductOptionGroupDetailPage params={resolvedParams('group-1')} />);

    expect(screen.getByText(/managed by Supervisor now/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Flavor' })).toBeInTheDocument();
    expect(screen.getByText('Cheese')).toBeInTheDocument();
    expect(screen.queryByLabelText('POS Button Label')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add option/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
  });
});
