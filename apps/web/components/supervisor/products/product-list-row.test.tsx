import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import type { ProductBranchView, ProductResponse } from '@potato-corner/shared';
import { ProductListRow } from './product-list-row';

const base = {
  id: 'p1',
  name: 'Cheese Fries',
  status: 'active',
  classification: 'regular',
  category_name: 'Fries',
  has_image: false,
  image_url: null,
  branch_exclusive: false,
  exclusive_branch_id: null,
  branches: [{ branch_id: 'a', branch_name: 'Branch A', is_available: true }],
} as unknown as ProductResponse;

function row(view: ProductBranchView, canEdit: boolean, overrides: Partial<ProductResponse> = {}) {
  const onAction = vi.fn();
  render(
    <ul>
      <ProductListRow product={{ ...base, ...overrides }} view={view} branchName="Branch A" canEdit={canEdit} canDeactivate onAction={onAction} />
    </ul>,
  );
  const group = screen.getByRole('group', { name: 'Actions for Cheese Fries' });
  const labels = Array.from(group.querySelectorAll('a, button')).map((el) => el.getAttribute('aria-label') ?? el.textContent);
  return { onAction, group, labels };
}

describe('ProductListRow actions', () => {
  afterEach(cleanup);

  it('active and editable: View, Edit, Deactivate, Permanently Delete, More, in that order', () => {
    const { labels, group, onAction } = row('active', true);
    expect(labels).toEqual(['View', 'Edit', 'Deactivate', 'Permanently Delete', 'More actions for Cheese Fries']);
    fireEvent.click(within(group).getByRole('button', { name: 'Permanently Delete' }));
    expect(onAction).toHaveBeenCalledWith('delete', expect.objectContaining({ id: 'p1' }));
  });

  it('inactive and editable: Activate takes the place of Deactivate', () => {
    const { labels } = row('inactive', true);
    expect(labels).toEqual(['View', 'Edit', 'Activate', 'Permanently Delete', 'More actions for Cheese Fries']);
  });

  it('draft: Continue Setup takes the place of Edit', () => {
    const { labels } = row('drafts', true, { status: 'draft' });
    expect(labels).toEqual(['View', 'Continue Setup', 'Permanently Delete', 'More actions for Cheese Fries']);
  });

  it('archived: View and Permanently Delete, no Edit', () => {
    const { labels } = row('inactive', true, { status: 'archived' });
    expect(labels).toEqual(['View', 'Permanently Delete', 'More actions for Cheese Fries']);
  });

  it('shared with a branch outside the assignment: view only, with the reason, and no Edit or Permanently Delete', async () => {
    const { labels } = row('active', false);
    expect(labels).toEqual(['View', 'Deactivate', 'More actions for Cheese Fries']);
    expect(screen.getByText('Set up for a branch outside your assignment — view only.')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions for Cheese Fries' }), { key: 'Enter' });
    expect(await screen.findByTestId('product-row-unavailable')).toHaveTextContent(
      'Edit, Archive and Permanently Delete need an assignment to every branch this product is set up for. Open View to create a branch copy',
    );
  });
});
