import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const mockUseDiscountAuditTrail = vi.fn();
const mockUseDiscountProof = vi.fn();
const mockUseEmployees = vi.fn();

vi.mock('@/hooks/queries/use-transactions', () => ({
  useDiscountAuditTrail: (...args: unknown[]) => mockUseDiscountAuditTrail(...args),
  useDiscountProof: (...args: unknown[]) => mockUseDiscountProof(...args),
}));

vi.mock('@/hooks/queries/use-employees', () => ({
  useEmployees: (...args: unknown[]) => mockUseEmployees(...args),
}));

const { DiscountComplianceDrilldown } = await import('./discount-compliance-drilldown');

const PWD_ROW = {
  id: 'txn-1',
  branchId: 'branch-1',
  transactionNumber: 'PC-GMA-001-20260731-000001',
  cashierId: 'cashier-1',
  discountType: 'pwd',
  discountAmount: 20,
  discountRateUsed: 20,
  discountCustomerId: 'PWD-12345',
  discountCustomerIdHash: 'hashed(PWD-12345)',
  hasDiscountProof: true,
  discountProofType: 'live_capture',
  fraudFlagged: false,
  createdAt: '2026-07-30T23:07:29.056Z',
};

const SENIOR_ROW = {
  ...PWD_ROW,
  id: 'txn-2',
  transactionNumber: 'PC-GMA-001-20260731-000002',
  discountType: 'senior_citizen',
  discountCustomerId: null,
  hasDiscountProof: false,
  discountProofType: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseDiscountAuditTrail.mockReturnValue({
    data: { data: [PWD_ROW, SENIOR_ROW], total: 2, page: 1, limit: 100 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mockUseDiscountProof.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  mockUseEmployees.mockReturnValue({ data: { employees: [{ id: 'cashier-1', first_name: 'Juan', last_name: 'Cruz' }] } });
});

afterEach(() => {
  cleanup();
});

describe('DiscountComplianceDrilldown', () => {
  it('renders every discount transaction behind the summary row', () => {
    render(
      <DiscountComplianceDrilldown
        open
        branchId="branch-1"
        branchName="Puregold GMA"
        discountType="pwd"
        dateFrom="2026-07-01"
        dateTo="2026-07-31"
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByText('PC-GMA-001-20260731-000001')).toBeInTheDocument();
    expect(screen.getByText('PC-GMA-001-20260731-000002')).toBeInTheDocument();
  });

  it('shows the rate actually used on each transaction, not a live-recomputed one (Task 209.xx)', () => {
    render(
      <DiscountComplianceDrilldown
        open
        branchId="branch-1"
        branchName="Puregold GMA"
        discountType="pwd"
        dateFrom="2026-07-01"
        dateTo="2026-07-31"
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getAllByText('20%')).toHaveLength(2);
  });

  it('resolves the cashier name from the employees lookup', () => {
    render(
      <DiscountComplianceDrilldown
        open
        branchId="branch-1"
        branchName="Puregold GMA"
        discountType="pwd"
        dateFrom="2026-07-01"
        dateTo="2026-07-31"
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getAllByText('Juan Cruz')).toHaveLength(2);
  });

  it('shows "Yes · View Proof" only for the row with a captured proof', () => {
    render(
      <DiscountComplianceDrilldown
        open
        branchId="branch-1"
        branchName="Puregold GMA"
        discountType="pwd"
        dateFrom="2026-07-01"
        dateTo="2026-07-31"
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('button', { name: /Yes · View Proof/ })).toHaveLength(1);
    expect(screen.getAllByText('No')).toHaveLength(1);
  });

  it('shows the customer ID/reference only when the actor is authorized to see it', () => {
    render(
      <DiscountComplianceDrilldown
        open
        branchId="branch-1"
        branchName="Puregold GMA"
        discountType="pwd"
        dateFrom="2026-07-01"
        dateTo="2026-07-31"
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByText('PWD-12345')).toBeInTheDocument();
  });

  it('scopes the query to the given branch, discount type, and date range', () => {
    render(
      <DiscountComplianceDrilldown
        open
        branchId="branch-1"
        branchName="Puregold GMA"
        discountType="pwd"
        dateFrom="2026-07-01"
        dateTo="2026-07-31"
        onOpenChange={vi.fn()}
      />,
    );
    expect(mockUseDiscountAuditTrail).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'branch-1', discountType: 'pwd', dateFrom: '2026-07-01', dateTo: '2026-07-31' }),
      true,
    );
  });

  it('shows a legitimate "No discount transactions" empty state when none match the filter, not a crash', () => {
    mockUseDiscountAuditTrail.mockReturnValue({
      data: { data: [], total: 0, page: 1, limit: 100 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <DiscountComplianceDrilldown
        open
        branchId="branch-1"
        branchName="Puregold GMA"
        discountType="pwd"
        dateFrom="2026-07-01"
        dateTo="2026-07-31"
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByText('No discount transactions')).toBeInTheDocument();
  });

  it('shows a retryable error state instead of crashing when the request fails', () => {
    mockUseDiscountAuditTrail.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    render(
      <DiscountComplianceDrilldown
        open
        branchId="branch-1"
        branchName="Puregold GMA"
        discountType="pwd"
        dateFrom="2026-07-01"
        dateTo="2026-07-31"
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /retry|try again/i })).toBeInTheDocument();
  });

  it('renders legacy rows with no discount type, no customer reference, and no proof without crashing', () => {
    mockUseDiscountAuditTrail.mockReturnValue({
      data: {
        data: [
          {
            id: 'txn-legacy',
            branchId: 'branch-1',
            transactionNumber: 'PC-GMA-001-20260601-000009',
            cashierId: 'cashier-1',
            discountType: null,
            discountAmount: 15,
            discountCustomerId: null,
            discountCustomerIdHash: null,
            hasDiscountProof: false,
            discountProofType: null,
            fraudFlagged: false,
            createdAt: '2026-06-01T10:00:00.000Z',
          },
        ],
        total: 1,
        page: 1,
        limit: 100,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <DiscountComplianceDrilldown
        open
        branchId="branch-1"
        branchName="Puregold GMA"
        discountType={null}
        dateFrom="2026-06-01"
        dateTo="2026-06-30"
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByText('PC-GMA-001-20260601-000009')).toBeInTheDocument();
    // discount type dash + discount rate used dash (Task 209.xx) + customer id/reference dash
    expect(screen.getAllByText('—')).toHaveLength(3);
    expect(screen.getByText('No')).toBeInTheDocument();
  });
});
