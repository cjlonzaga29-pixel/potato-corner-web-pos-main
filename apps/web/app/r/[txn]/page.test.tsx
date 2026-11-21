import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { PublicReceipt } from '@/hooks/queries/use-receipts';
import PublicReceiptPage from './page';

const mockUsePublicReceipt = vi.fn();

vi.mock('next/navigation', () => ({ useParams: () => ({ txn: 'PC-1' }) }));
vi.mock('@/hooks/queries/use-receipts', () => ({ usePublicReceipt: (txn: string) => mockUsePublicReceipt(txn) }));

function receipt(overrides: Partial<PublicReceipt> = {}): PublicReceipt {
  return {
    receipt_number: 'PC-1',
    branch_name: 'Main',
    status: 'completed',
    created_at: '2026-11-03T02:00:00.000Z',
    items: [],
    subtotal: 100,
    discount_amount: 25,
    discount_type: 'manual',
    manual_discount_name: 'PWD',
    discount_rate_used: null,
    calculation_mode: 'manual_total_v1',
    vat_amount: null,
    vat_exempt_amount: null,
    total_amount: 75,
    payment_method: 'cash',
    cash_tendered: 100,
    change_given: 25,
    gcash_reference_number: null,
    ...overrides,
  } as PublicReceipt;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PublicReceiptPage (POS-PERF-P59)', () => {
  it('a custom type named PWD prints PWD, never Manual, with the stored total and no VAT message', () => {
    mockUsePublicReceipt.mockReturnValue({ data: receipt(), isLoading: false, isError: false, refetch: vi.fn() });
    render(<PublicReceiptPage />);
    expect(screen.getByText('PWD discount')).toBeInTheDocument();
    expect(screen.getByText('₱75.00')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/manual|\bVAT\b|not calculated/i);
  });

  it('a VAT-calculated historical sale keeps its label and total, without showing its stored VAT', () => {
    mockUsePublicReceipt.mockReturnValue({
      data: receipt({ discount_type: 'pwd', manual_discount_name: null, discount_rate_used: 20, calculation_mode: 'legacy_vat_v1', vat_amount: 0, vat_exempt_amount: 0 }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<PublicReceiptPage />);
    expect(screen.getByText('PWD Discount (20%)')).toBeInTheDocument();
    expect(screen.getByText('₱75.00')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bVAT\b|VAT-exempt/);
  });

  it('a manual sale with no saved name stays a plain Discount line', () => {
    mockUsePublicReceipt.mockReturnValue({ data: receipt({ manual_discount_name: null }), isLoading: false, isError: false, refetch: vi.fn() });
    render(<PublicReceiptPage />);
    expect(screen.getByText('Discount')).toBeInTheDocument();
  });
});
