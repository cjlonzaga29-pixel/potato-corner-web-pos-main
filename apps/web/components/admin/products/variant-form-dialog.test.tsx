import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VariantFormDialog } from './variant-form-dialog';

const { mockUseCreateVariant, mockUseUpdateVariant } = vi.hoisted(() => ({
  mockUseCreateVariant: vi.fn(),
  mockUseUpdateVariant: vi.fn(),
}));

vi.mock('@/hooks/queries/use-products', () => ({
  useCreateVariant: mockUseCreateVariant,
  useUpdateVariant: mockUseUpdateVariant,
}));

describe('VariantFormDialog', () => {
  it('gives the Base Price CurrencyInput an accessible name', () => {
    mockUseCreateVariant.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mockUseUpdateVariant.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<VariantFormDialog open onOpenChange={vi.fn()} productId="product-1" />);

    expect(screen.getByLabelText(/base price/i)).toBeInTheDocument();
  });
});
