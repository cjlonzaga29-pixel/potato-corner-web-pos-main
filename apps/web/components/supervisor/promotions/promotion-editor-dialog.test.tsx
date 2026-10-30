import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { PromotionEligibleProduct, PromotionResponse } from '@potato-corner/shared';

/**
 * POS-PERF-P49 — the promotion editor: clear per-item wording with examples,
 * a price preview from the shared pricing rule, ineligible products disabled
 * with the reason, overlap explained, and server refusals shown inline.
 */
const { mockCreate, mockUpdate, MockPromotionApiError } = vi.hoisted(() => {
  class MockPromotionApiError extends Error {
    constructor(
      message: string,
      public readonly code: string | undefined,
      public readonly details: unknown,
    ) {
      super(message);
    }
  }
  return { mockCreate: vi.fn(), mockUpdate: vi.fn(), MockPromotionApiError };
});

const PRODUCT_A = '11111111-1111-4111-8111-111111111111';
const PRODUCT_REGULAR = '22222222-2222-4222-8222-222222222222';
const BRANCH_MAIN = '33333333-3333-4333-8333-333333333333';

const eligible: PromotionEligibleProduct[] = [
  {
    id: PRODUCT_A,
    name: 'Promo Fries',
    classification: 'promotional',
    status: 'active',
    branch_ids: [BRANCH_MAIN],
    ineligible_reason: null,
    variants: [
      { id: 'v-reg', name: 'Regular', base_price: 39, is_active: true },
      { id: 'v-lg', name: 'Large', base_price: 99, is_active: true },
    ],
  },
  {
    id: PRODUCT_REGULAR,
    name: 'Plain Fries',
    classification: 'regular',
    status: 'active',
    branch_ids: [BRANCH_MAIN],
    ineligible_reason: 'Only Promotional or Seasonal products can have a promotion. Change the classification in the product editor first.',
    cashier_selected_ineligible_reason: null,
    variants: [{ id: 'v-plain', name: 'Regular', base_price: 45, is_active: true }],
  },
];

vi.mock('@/hooks/queries/use-promotions', () => ({
  PromotionApiError: MockPromotionApiError,
  usePromotionEligibleProducts: () => ({ data: eligible, isLoading: false, isError: false, error: null }),
  useCreatePromotion: () => ({ mutateAsync: mockCreate, isPending: false }),
  useUpdatePromotion: () => ({ mutateAsync: mockUpdate, isPending: false }),
}));

const { PromotionEditorDialog } = await import('./promotion-editor-dialog');

function existing(overrides: Partial<PromotionResponse> = {}): PromotionResponse {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Ten Off',
    discount_kind: 'fixed_amount',
    discount_value: 10,
    is_enabled: true,
    application_mode: 'automatic',
    starts_on: null,
    ends_on: null,
    schedule_state: 'active',
    version: 3,
    products: [{ id: PRODUCT_A, name: 'Promo Fries', classification: 'promotional' }],
    branches: [{ id: BRANCH_MAIN, name: 'Main' }],
    can_edit: true,
    read_only_reason: null,
    created_at: '2026-10-30T00:00:00.000Z',
    updated_at: '2026-10-30T00:00:00.000Z',
    ...overrides,
  };
}

function renderEditor(promotion: PromotionResponse | null = null, allPromotions: PromotionResponse[] = []) {
  const onOpenChange = vi.fn();
  render(
    <PromotionEditorDialog open onOpenChange={onOpenChange} promotion={promotion} allPromotions={allPromotions} branches={[{ id: BRANCH_MAIN, name: 'Main' }]} />,
  );
  return { onOpenChange };
}

afterEach(cleanup);
beforeEach(() => {
  mockCreate.mockReset().mockResolvedValue(existing());
  mockUpdate.mockReset().mockResolvedValue(existing());
});

describe('PromotionEditorDialog (P49)', () => {
  it('explains a fixed amount as per item with an example, and previews original/discount/final with the cap', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('radio', { name: /Fixed amount off each item/ }));
    expect(screen.getByText(/This is not a whole-order discount/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Promo Fries' }));
    fireEvent.change(screen.getByLabelText('Pesos off each item'), { target: { value: '50' } });

    const preview = screen.getByRole('table', { name: 'Price preview' });
    const regular = within(preview).getByText('Promo Fries — Regular').closest('tr') as HTMLElement;
    expect(regular).toHaveTextContent('₱39.00');
    expect(regular).toHaveTextContent('−₱39.00');
    expect(regular).toHaveTextContent('Capped at the item price — sells for ₱0.00');
    const large = within(preview).getByText('Promo Fries — Large').closest('tr') as HTMLElement;
    expect(large).toHaveTextContent('−₱50.00');
    expect(large).toHaveTextContent('₱49.00');
  });

  it('rounds a percentage per item in the preview', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Promo Fries' }));
    fireEvent.change(screen.getByLabelText('Percent off (1–100)'), { target: { value: '15' } });
    const row = within(screen.getByRole('table', { name: 'Price preview' })).getByText('Promo Fries — Regular').closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('−₱5.85');
    expect(row).toHaveTextContent('₱33.15');
  });

  it('disables a Regular product with the reason', () => {
    renderEditor();
    expect(screen.getByRole('checkbox', { name: 'Plain Fries' })).toBeDisabled();
    expect(screen.getByText(/Only Promotional or Seasonal products can have a promotion/)).toBeInTheDocument();
  });

  it('creates with exactly the selected products/branches and optional dates, and closes', async () => {
    const { onOpenChange } = renderEditor();
    fireEvent.change(screen.getByLabelText('Discount name'), { target: { value: 'Halloween' } });
    fireEvent.change(screen.getByLabelText('Percent off (1–100)'), { target: { value: '12.5' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Promo Fries' }));
    fireEvent.change(screen.getByLabelText('End date (optional)'), { target: { value: '2026-10-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create promotion' }));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({
        name: 'Halloween',
        discount_kind: 'percentage',
        discount_value: 12.5,
        is_enabled: true,
        application_mode: 'automatic',
        starts_on: null,
        ends_on: '2026-10-31',
        product_ids: [PRODUCT_A],
        branch_ids: [BRANCH_MAIN],
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('validates before sending: no product, no amount, percent over 100', async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText('Discount name'), { target: { value: 'Bad' } });
    fireEvent.change(screen.getByLabelText('Percent off (1–100)'), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create promotion' }));
    expect(await screen.findByText('A percentage cannot exceed 100')).toBeInTheDocument();
    expect(screen.getByText('Select at least one product')).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('saves an edit with the version it was loaded from and shows a conflict inline without closing', async () => {
    mockUpdate.mockRejectedValueOnce(new MockPromotionApiError('This promotion was changed by someone else since you opened it.', 'PROMOTION_CONFLICT', undefined));
    const { onOpenChange } = renderEditor(existing());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ expected_version: 3, product_ids: [PRODUCT_A] })));
    expect(await screen.findByText('Not saved — changed elsewhere')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('lists each ineligible product the server refused', async () => {
    mockCreate.mockRejectedValueOnce(
      new MockPromotionApiError('Promo Fries: This product is not sold at any of the selected branches.', 'PROMOTION_PRODUCT_INELIGIBLE', {
        products: [{ product_name: 'Promo Fries', reason: 'This product is not sold at any of the selected branches.' }],
      }),
    );
    renderEditor();
    fireEvent.change(screen.getByLabelText('Discount name'), { target: { value: 'Promo' } });
    fireEvent.change(screen.getByLabelText('Percent off (1–100)'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Promo Fries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create promotion' }));
    expect(await screen.findByText('Not saved')).toBeInTheDocument();
    expect(screen.getAllByText(/not sold at any of the selected branches/).length).toBeGreaterThanOrEqual(1);
  });

  it('explains overlap with another active promotion on the same product and branch', () => {
    renderEditor(null, [existing({ id: '55555555-5555-4555-8555-555555555555', name: 'Other Promo' })]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Promo Fries' }));
    expect(screen.getByTestId('promotion-overlap')).toHaveTextContent('Other Promo');
    expect(screen.getByTestId('promotion-overlap')).toHaveTextContent('the bigger one');
  });
});

describe('PromotionEditorDialog — Create/Edit Discount (P50R)', () => {
  it('a cashier-selected discount may name a Regular product, says how selection works, and is sent with its mode', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('radio', { name: /Cashier selects at checkout/ }));
    expect(screen.getByTestId('selection-requirement-note')).toHaveTextContent('No applicable discount');
    expect(screen.getByRole('checkbox', { name: 'Plain Fries' })).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('Discount name'), { target: { value: 'Loyalty' } });
    fireEvent.change(screen.getByLabelText('Percent off (1–100)'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Plain Fries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create discount' }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ application_mode: 'cashier_selected', product_ids: [PRODUCT_REGULAR] })));
  });

  it('explains the taxable VAT treatment and previews taxable amount, VAT and final price', () => {
    renderEditor();
    expect(screen.getByTestId('promotion-vat-treatment')).toHaveTextContent('never makes a sale VAT-exempt');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Promo Fries' }));
    fireEvent.change(screen.getByLabelText('Percent off (1–100)'), { target: { value: '10' } });
    // ₱39.00 − ₱3.90 = ₱35.10; VAT = 35.10 × 12/112 = ₱3.76; taxable net of VAT ₱31.34.
    const row = within(screen.getByRole('table', { name: 'Price preview' })).getByText('Promo Fries — Regular').closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('₱31.34');
    expect(row).toHaveTextContent('₱3.76');
    expect(row).toHaveTextContent('₱35.10');
  });

  it('an existing promotion from an older API (no mode) edits as automatic', () => {
    const legacy = existing();
    delete (legacy as Partial<PromotionResponse>).application_mode;
    renderEditor(legacy);
    expect(screen.getByRole('radio', { name: /Automatic promotion/ })).toBeChecked();
  });
});
