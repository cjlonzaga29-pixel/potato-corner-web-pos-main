import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExtraSupplyIssueResponse, ExtraSupplyTerminalCard } from '@potato-corner/shared';
import { ExtraSuppliesPanel } from './extra-supplies-panel';
import { extraSupplyDraftKey, useExtraSupplyDraftStore } from '@/stores/extra-supply-draft.store';

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  fetchOperation: vi.fn(),
  abandon: vi.fn(),
  cards: vi.fn(),
}));

vi.mock('@/hooks/queries/use-extra-supplies', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/queries/use-extra-supplies')>('@/hooks/queries/use-extra-supplies');
  return {
    ...actual,
    submitExtraSupplyIssue: mocks.submit,
    fetchExtraSupplyOperation: mocks.fetchOperation,
    abandonExtraSupplyOperation: mocks.abandon,
    useExtraSupplyCards: mocks.cards,
  };
});

vi.mock('@/hooks/queries/use-transactions', () => ({
  useUploadPaymentProof: () => ({ mutateAsync: vi.fn().mockResolvedValue({ payment_proof_key: 'k', payment_proof_type: 'gallery_upload' }) }),
}));

const BRANCH = '11111111-1111-4111-8111-111111111111';
const CASHIER_A = '22222222-2222-4222-8222-222222222222';
const CASHIER_B = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';

function card(overrides: Partial<ExtraSupplyTerminalCard> = {}): ExtraSupplyTerminalCard {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Paper Cup',
    image_url: null,
    issue_unit_name: 'cup',
    inventory_item_id: ITEM,
    inventory_item_name: 'Cups',
    base_quantity: 1,
    base_unit_code: 'pc',
    selling_price: 5,
    version: 3,
    available_base_quantity: 10,
    available_issue_quantity: 10,
    ...overrides,
  };
}

const posted = { id: 'i1', reference_number: 'ES-X-20261103-000001', kind: 'free', amount_collected: 0, change_amount: null } as unknown as ExtraSupplyIssueResponse;

function renderPanel(props: Partial<Parameters<typeof ExtraSuppliesPanel>[0]> = {}) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ExtraSuppliesPanel branchId={BRANCH} cashierId={CASHIER_A} isOnline {...props} />
    </QueryClientProvider>,
  );
}

function setCards(cards: ExtraSupplyTerminalCard[], extra: Record<string, unknown> = {}) {
  mocks.cards.mockReturnValue({ data: cards, isLoading: false, isError: false, error: null, refetch: vi.fn(), ...extra });
}

async function selectFreeAndReview() {
  fireEvent.click(screen.getByRole('button', { name: /more paper cup/i }));
  fireEvent.click(screen.getByRole('radio', { name: /give free/i }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Spilled drink' } });
  fireEvent.click(screen.getByTestId('extra-supplies-review'));
}

function pendingOf(cashier = CASHIER_A) {
  return useExtraSupplyDraftStore.getState().drafts[extraSupplyDraftKey(BRANCH, cashier)]?.pending ?? null;
}

describe('ExtraSuppliesPanel', () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    useExtraSupplyDraftStore.setState({ drafts: {} });
    setCards([card()]);
  });

  it('builds the request from the live card, with no cashier, shift or amount, and only then says stock was deducted', async () => {
    mocks.submit.mockResolvedValue(posted);
    renderPanel();
    await selectFreeAndReview();
    expect(screen.queryByTestId('extra-supplies-result')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('extra-supplies-confirm'));
    const [payload] = mocks.submit.mock.calls[0] as [Record<string, unknown>];
    expect(payload).toMatchObject({ branch_id: BRANCH, kind: 'free', reason: 'Spilled drink', lines: [{ extra_supply_id: card().id, quantity: 1, version: 3 }] });
    expect(payload).not.toHaveProperty('cashier_id');
    expect(payload).not.toHaveProperty('shift_id');
    expect(payload).not.toHaveProperty('amount_collected');

    expect(await screen.findByTestId('extra-supplies-reference')).toHaveTextContent('ES-X-20261103-000001');
    expect(screen.getByTestId('extra-supplies-result')).toHaveTextContent('Stock was deducted by the server');
    expect(pendingOf()).toBeNull();
  });

  it('saves the operation id before sending, and sends once on a double click', async () => {
    let release: (value: ExtraSupplyIssueResponse) => void = () => undefined;
    mocks.submit.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    renderPanel();
    await selectFreeAndReview();
    const confirm = screen.getByTestId('extra-supplies-confirm');
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    const [payload] = mocks.submit.mock.calls[0] as [{ operation_id: string }];
    expect(pendingOf()?.operationId).toBe(payload.operation_id);
    release(posted);
    await screen.findByTestId('extra-supplies-result');
  });

  it('a lost reply keeps the id, locks the draft, and retries only under the same id', async () => {
    mocks.submit.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderPanel();
    await selectFreeAndReview();
    fireEvent.click(screen.getByTestId('extra-supplies-confirm'));

    expect(await screen.findByTestId('extra-supplies-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('extra-supplies-grid')).not.toBeInTheDocument();
    const first = pendingOf();
    expect(first).not.toBeNull();

    mocks.submit.mockResolvedValueOnce(posted);
    fireEvent.click(screen.getByTestId('extra-supplies-retry'));
    await screen.findByTestId('extra-supplies-result');
    const calls = mocks.submit.mock.calls as [{ operation_id: string }][];
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[0].operation_id).toBe(calls[0]?.[0].operation_id);
    expect(calls[1]?.[0]).toEqual(calls[0]?.[0]);
  });

  it.each(['NETWORK_ERROR', 'UNREADABLE_RESPONSE', 'SOME_FUTURE_CODE'])('%s from the API client keeps the id and draft locked, so no second issue can start', async (code) => {
    const { ExtraSupplyRequestError } = await import('@/hooks/queries/use-extra-supplies');
    mocks.submit.mockRejectedValueOnce(new ExtraSupplyRequestError('Could not reach the server.', code));
    renderPanel();
    await selectFreeAndReview();
    fireEvent.click(screen.getByTestId('extra-supplies-confirm'));
    await screen.findByTestId('extra-supplies-retry');
    expect(pendingOf()).not.toBeNull();
    expect(screen.queryByTestId('extra-supplies-grid')).not.toBeInTheDocument();
  });

  it('after a reload, a committed outcome shows the reference and never submits again', async () => {
    useExtraSupplyDraftStore.getState().update(extraSupplyDraftKey(BRANCH, CASHIER_A), { quantities: { [card().id]: 1 }, pending: { operationId: 'op-1', payload: {} as never, attempts: 1 } });
    mocks.fetchOperation.mockResolvedValue({ status: 'committed', issue: posted });
    renderPanel();
    expect(await screen.findByTestId('extra-supplies-reference')).toBeInTheDocument();
    expect(mocks.fetchOperation).toHaveBeenCalledWith('op-1', expect.anything());
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(pendingOf()).toBeNull();
  });

  it('an unknown outcome is not treated as failure: no new submission until the server has decided', async () => {
    useExtraSupplyDraftStore.getState().update(extraSupplyDraftKey(BRANCH, CASHIER_A), { quantities: { [card().id]: 1 }, pending: { operationId: 'op-2', payload: {} as never, attempts: 1 } });
    mocks.fetchOperation.mockResolvedValue({ status: 'not_found' });
    renderPanel();
    await screen.findByTestId('extra-supplies-cancel-attempt');
    expect(screen.queryByTestId('extra-supplies-confirm')).not.toBeInTheDocument();
    expect(mocks.submit).not.toHaveBeenCalled();

    // Cancelling reports the issue if the server had posted it after all.
    mocks.abandon.mockResolvedValueOnce({ status: 'committed', issue: posted });
    fireEvent.click(screen.getByTestId('extra-supplies-cancel-attempt'));
    expect(await screen.findByTestId('extra-supplies-reference')).toBeInTheDocument();
  });

  it('a fenced cancel frees the draft for a new attempt, with a new id', async () => {
    useExtraSupplyDraftStore.getState().update(extraSupplyDraftKey(BRANCH, CASHIER_A), { quantities: { [card().id]: 1 }, kind: 'free', reason: 'r', pending: { operationId: 'op-3', payload: {} as never, attempts: 1 } });
    mocks.fetchOperation.mockResolvedValue({ status: 'not_found' });
    mocks.abandon.mockResolvedValueOnce({ status: 'abandoned' });
    mocks.submit.mockResolvedValue(posted);
    renderPanel();
    fireEvent.click(await screen.findByTestId('extra-supplies-cancel-attempt'));
    fireEvent.click(await screen.findByTestId('extra-supplies-confirm'));
    await screen.findByTestId('extra-supplies-result');
    expect((mocks.submit.mock.calls[0] as [{ operation_id: string }])[0].operation_id).not.toBe('op-3');
  });

  it('being rate limited is a refusal: the request never reached the issue handler', async () => {
    const { ExtraSupplyRequestError } = await import('@/hooks/queries/use-extra-supplies');
    mocks.submit.mockRejectedValueOnce(new ExtraSupplyRequestError('Too many requests. Please try again later.', 'RATE_LIMIT_EXCEEDED'));
    renderPanel();
    await selectFreeAndReview();
    fireEvent.click(screen.getByTestId('extra-supplies-confirm'));
    expect(await screen.findByTestId('extra-supplies-error')).toHaveTextContent('Too many requests');
    expect(pendingOf()).toBeNull();
  });

  it('a first-attempt refusal keeps the draft and frees the id; a retry refusal does not prove anything', async () => {
    const { ExtraSupplyRequestError } = await import('@/hooks/queries/use-extra-supplies');
    mocks.submit.mockRejectedValueOnce(new ExtraSupplyRequestError('Not enough Cups', 'INSUFFICIENT_STOCK'));
    renderPanel();
    await selectFreeAndReview();
    fireEvent.click(screen.getByTestId('extra-supplies-confirm'));
    expect(await screen.findByTestId('extra-supplies-error')).toHaveTextContent('Not enough Cups');
    expect(pendingOf()).toBeNull();
    expect(screen.getByTestId('extra-supplies-grid')).toBeInTheDocument();
    expect(useExtraSupplyDraftStore.getState().drafts[extraSupplyDraftKey(BRANCH, CASHIER_A)]?.quantities).toEqual({ [card().id]: 1 });

    mocks.submit.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.click(screen.getByTestId('extra-supplies-review'));
    fireEvent.click(screen.getByTestId('extra-supplies-confirm'));
    const retry = await screen.findByTestId('extra-supplies-retry');
    mocks.submit.mockRejectedValueOnce(new ExtraSupplyRequestError('On break', 'ON_BREAK'));
    fireEvent.click(retry);
    expect(await screen.findByTestId('extra-supplies-error')).toHaveTextContent('On break');
    expect(pendingOf()).not.toBeNull();
  });

  it('offline: confirmation is disabled, nothing is sent, and the draft stays', async () => {
    renderPanel({ isOnline: false });
    expect(screen.getByTestId('extra-supplies-offline')).toBeInTheDocument();
    await selectFreeAndReview();
    expect(screen.getByTestId('extra-supplies-confirm')).toBeDisabled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(useExtraSupplyDraftStore.getState().drafts[extraSupplyDraftKey(BRANCH, CASHIER_A)]?.quantities).toEqual({ [card().id]: 1 });
  });

  it('new web on an old API: explains, keeps the draft, and writes nothing', async () => {
    const { ExtraSupplyRequestError, EXTRA_SUPPLIES_NOT_DEPLOYED } = await import('@/hooks/queries/use-extra-supplies');
    useExtraSupplyDraftStore.getState().update(extraSupplyDraftKey(BRANCH, CASHIER_A), { quantities: { [card().id]: 2 } });
    setCards([], { data: undefined, isError: true, error: new ExtraSupplyRequestError('unavailable', EXTRA_SUPPLIES_NOT_DEPLOYED) });
    renderPanel();
    expect(screen.getByTestId('extra-supplies-unavailable')).toBeInTheDocument();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(useExtraSupplyDraftStore.getState().drafts[extraSupplyDraftKey(BRANCH, CASHIER_A)]?.quantities).toEqual({ [card().id]: 2 });
  });

  it('switching cashier shows their own draft, never the previous cashier selection or pending payment', async () => {
    const { unmount } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /more paper cup/i }));
    fireEvent.click(screen.getByRole('radio', { name: /with payment/i }));
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '100' } });
    unmount();

    renderPanel({ cashierId: CASHIER_B });
    expect(screen.getByLabelText(/quantity of paper cup/i)).toHaveValue('');
    expect(screen.queryByTestId('extra-supplies-entry')).not.toBeInTheDocument();
    expect(useExtraSupplyDraftStore.getState().drafts[extraSupplyDraftKey(BRANCH, CASHIER_A)]?.cashTendered).toBe('100');
  });

  it('cards sharing an item share availability, and an amount is shown from the fresh price', async () => {
    const shared = card({ id: '66666666-6666-4666-8666-666666666666', name: 'Paper Cup Pack', base_quantity: 5, available_issue_quantity: 2 });
    setCards([card(), shared]);
    renderPanel();
    const grid = screen.getByTestId('extra-supplies-grid');
    fireEvent.change(within(grid).getByLabelText(/quantity of paper cup$/i), { target: { value: '6' } });
    // 10 available, 6 used by the other card: one pack of 5 no longer fits twice.
    const packCard = screen.getByLabelText(/quantity of paper cup pack/i).closest('[data-testid="extra-supply-card"]') as HTMLElement;
    expect(within(packCard).getByTestId('extra-supply-available')).toHaveTextContent('0 cup available');
    fireEvent.click(screen.getByRole('radio', { name: /with payment/i }));
    expect(screen.getByTestId('extra-supplies-amount')).toHaveTextContent('30.00');
  });

  it('a card with no price cannot be taken for payment, and too little cash blocks review', async () => {
    setCards([card({ selling_price: null })]);
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /more paper cup/i }));
    fireEvent.click(screen.getByRole('radio', { name: /with payment/i }));
    expect(screen.getByTestId('extra-supplies-blocker')).toHaveTextContent('no selling price');
    expect(screen.getByTestId('extra-supplies-review')).toBeDisabled();
  });
});
