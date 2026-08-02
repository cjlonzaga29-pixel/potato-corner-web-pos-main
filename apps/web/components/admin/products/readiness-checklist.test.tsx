import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ProductReadinessResponse } from '@potato-corner/shared';
import { ReadinessChecklist } from './readiness-checklist';

function readiness(overrides: Partial<ProductReadinessResponse> = {}): ProductReadinessResponse {
  return {
    scope: 'branch',
    product_id: 'product-1',
    branch_id: 'branch-1',
    status: 'NOT_READY',
    sellable: false,
    completion_percentage: 50,
    variant_count: 1,
    eligible_variant_count: 1,
    ready_variant_count: 0,
    blocking_issues: [],
    warnings: [],
    variants: [],
    publish_is_variant_level: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('ReadinessChecklist', () => {
  it('renders the supplied blocking issues with severity, message, and recommended action', () => {
    const data = readiness({
      blocking_issues: [
        {
          code: 'NO_RECIPE',
          severity: 'blocking',
          entity_type: 'product_variant',
          message: 'Small has no recipe configured',
          recommended_action: 'Add a recipe for this variant',
          flavor_name: null,
        },
      ],
    });

    render(<ReadinessChecklist data={data} onNavigateToTab={vi.fn()} />);

    expect(screen.getByText('Blocking Issues')).toBeInTheDocument();
    expect(screen.getByText('Small has no recipe configured')).toBeInTheDocument();
    expect(screen.getByText('Recommended action: Add a recipe for this variant')).toBeInTheDocument();
    expect(screen.getByText('blocking')).toBeInTheDocument();
  });

  it('renders the supplied warnings separately from blocking issues', () => {
    const data = readiness({
      warnings: [
        {
          code: 'LOW_STOCK',
          severity: 'warning',
          entity_type: 'flavor',
          message: 'Cheese flavor is low on stock',
          recommended_action: 'Restock cheese flavor',
          flavor_name: 'Cheese',
        },
      ],
    });

    render(<ReadinessChecklist data={data} onNavigateToTab={vi.fn()} />);

    expect(screen.getByText('Warnings')).toBeInTheDocument();
    expect(screen.getByText('Cheese flavor is low on stock')).toBeInTheDocument();
    expect(screen.getByText('warning')).toBeInTheDocument();
  });

  it('shows the empty-state copy when there are no blocking issues or warnings', () => {
    render(<ReadinessChecklist data={readiness()} onNavigateToTab={vi.fn()} />);

    expect(screen.getByText('No blocking issues.')).toBeInTheDocument();
    expect(screen.getByText('No warnings.')).toBeInTheDocument();
  });

  it('groups per-variant issues under the variant name in the Variant Breakdown section', () => {
    const data = readiness({
      variants: [
        {
          product_variant_id: 'variant-1',
          variant_name: 'Small',
          status: 'NOT_READY',
          sellable: false,
          completion_percentage: 50,
          recipe_ready: false,
          inventory_mapping_ready: true,
          blocking_issues: [
            {
              code: 'NO_RECIPE',
              severity: 'blocking',
              entity_type: 'product_variant',
              message: 'Small has no recipe configured',
              recommended_action: 'Add a recipe for this variant',
              flavor_name: null,
            },
          ],
          warnings: [],
        },
      ],
    });

    render(<ReadinessChecklist data={data} onNavigateToTab={vi.fn()} />);

    expect(screen.getByText('Variant Breakdown')).toBeInTheDocument();
    expect(screen.getByText('Small')).toBeInTheDocument();
    expect(screen.getByText('Recipe: Missing')).toBeInTheDocument();
    expect(screen.getByText('Inventory Mapping: Complete')).toBeInTheDocument();
    // Compact per-variant IssueSection omits the "Blocking Issues" heading but still shows the issue text.
    expect(screen.getByText('Small has no recipe configured')).toBeInTheDocument();
  });

  it('shows the no-eligible-variants copy when the variant list is empty', () => {
    render(<ReadinessChecklist data={readiness()} onNavigateToTab={vi.fn()} />);

    expect(screen.getByText('No eligible (active) variants to evaluate at this branch.')).toBeInTheDocument();
  });

  it('invokes onNavigateToTab with the target tab id when the quick-action links are clicked', () => {
    const onNavigateToTab = vi.fn();
    render(<ReadinessChecklist data={readiness()} onNavigateToTab={onNavigateToTab} />);

    fireEvent.click(screen.getByRole('button', { name: 'Manage Variants, Flavors, Inventory Mapping & Recipe/BOM' }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage Branch Availability' }));

    expect(onNavigateToTab).toHaveBeenNthCalledWith(1, 'variants');
    expect(onNavigateToTab).toHaveBeenNthCalledWith(2, 'availability');
  });
});
