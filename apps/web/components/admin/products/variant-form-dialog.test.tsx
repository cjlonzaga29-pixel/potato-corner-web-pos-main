import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { Dialog, DialogContent, DialogHost, DialogTitle } from '@/components/ui/dialog';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import type { ProductVariantResponse } from '@potato-corner/shared';
import { VariantFormDialog } from './variant-form-dialog';

const { mockUseCreateVariant, mockUseUpdateVariant, mockRefetchProduct, MockProductApiError } = vi.hoisted(() => {
  class MockProductApiError extends Error {
    constructor(
      message: string,
      public readonly code: string | undefined,
    ) {
      super(message);
    }
  }
  return { mockUseCreateVariant: vi.fn(), mockUseUpdateVariant: vi.fn(), mockRefetchProduct: vi.fn(), MockProductApiError };
});

vi.mock('@/hooks/queries/use-products', () => ({
  useCreateVariant: mockUseCreateVariant,
  useUpdateVariant: mockUseUpdateVariant,
  useProduct: () => ({ refetch: mockRefetchProduct }),
  ProductApiError: MockProductApiError,
}));

/** A stand-in for useMutation that keeps `error` as state, like the real hook, so the form re-renders with it. */
function fakeMutation(run: (input: Record<string, unknown>) => Promise<unknown>) {
  return function useFakeMutation() {
    const [error, setError] = useState<Error | null>(null);
    return {
      isPending: false,
      error,
      reset: () => setError(null),
      mutateAsync: async (input: Record<string, unknown>) => {
        try {
          return await run(input);
        } catch (caught) {
          setError(caught as Error);
          throw caught;
        }
      },
    };
  };
}

function variant(overrides: Partial<ProductVariantResponse> = {}): ProductVariantResponse {
  return {
    id: 'variant-1',
    name: 'Regular',
    size_label: 'Regular',
    base_price: 50,
    display_order: 0,
    is_active: true,
    version: 3,
    ...overrides,
  } as ProductVariantResponse;
}

afterEach(cleanup);

beforeEach(() => {
  mockUseCreateVariant.mockReset().mockImplementation(fakeMutation(async () => ({})));
  mockUseUpdateVariant.mockReset().mockImplementation(fakeMutation(async () => ({})));
  mockRefetchProduct.mockReset();
});

describe('VariantFormDialog', () => {
  it('gives the Base Price CurrencyInput an accessible name', () => {
    render(<VariantFormDialog open onOpenChange={vi.fn()} productId="product-1" />);

    expect(screen.getByLabelText(/base price/i)).toBeInTheDocument();
  });

  // POS-PERF-P41
  it('keeps the form open with what was typed and shows why when adding fails', async () => {
    mockUseCreateVariant.mockImplementation(
      fakeMutation(async () => {
        throw new MockProductApiError('A size with this name already exists', 'VARIANT_NAME_TAKEN');
      }),
    );
    const onOpenChange = vi.fn();
    render(<VariantFormDialog open onOpenChange={onOpenChange} productId="product-1" />);
    fireEvent.change(screen.getByRole('textbox', { name: /Variant Name/ }), { target: { value: 'Jumbo' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Size Label/ }), { target: { value: 'J' } });
    fireEvent.change(screen.getByRole('textbox', { name: /base price/i }), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Variant' }));

    expect(await screen.findByTestId('form-save-error')).toHaveTextContent('A size with this name already exists');
    expect(screen.getByRole('textbox', { name: /Variant Name/ })).toHaveValue('Jumbo');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('on a version conflict keeps the typed values, and Load latest deliberately replaces them and saves against the newer version', async () => {
    const update = vi.fn().mockRejectedValueOnce(new MockProductApiError('Variant was changed', 'VARIANT_CONFLICT')).mockResolvedValue({});
    mockUseUpdateVariant.mockImplementation(fakeMutation(update));
    mockRefetchProduct.mockResolvedValue({ data: { variants: [variant({ name: 'Regular (saved elsewhere)', version: 4 })] } });
    const onOpenChange = vi.fn();
    render(<VariantFormDialog open onOpenChange={onOpenChange} productId="product-1" variant={variant()} />);

    fireEvent.change(screen.getByRole('textbox', { name: /Variant Name/ }), { target: { value: 'My rename' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText(/changed elsewhere after you opened it/)).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ name: 'My rename', expected_version: 3 }));
    expect(screen.getByRole('textbox', { name: /Variant Name/ })).toHaveValue('My rename');

    fireEvent.click(screen.getByRole('button', { name: /Load latest/ }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: /Variant Name/ })).toHaveValue('Regular (saved elsewhere)'));
    await waitFor(() => expect(screen.queryByTestId('form-save-error')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Regular (saved elsewhere)', expected_version: 4 })));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  // POS-PERF-P41 — the real form, hosted the way the product editor hosts it: what it types is what Back protects.
  it('hosted in the product editor, Back asks before discarding a typed size', async () => {
    function Host() {
      const [container, setContainer] = useState<HTMLDivElement | null>(null);
      const [open, setOpen] = useState(true);
      return (
        <Dialog open>
          <DialogContent>
            <DialogTitle>Edit Cheese Fries</DialogTitle>
            <DialogHost container={container} backLabel="Back to Sizes & Prices">
              <VariantFormDialog open={open} onOpenChange={setOpen} productId="product-1" />
              <div ref={setContainer} />
            </DialogHost>
          </DialogContent>
        </Dialog>
      );
    }
    render(<Host />);
    const section = await screen.findByRole('region', { name: 'Add Variant' });
    fireEvent.change(within(section).getByRole('textbox', { name: /Variant Name/ }), { target: { value: 'Jumbo' } });

    fireEvent.click(await within(section).findByRole('button', { name: 'Back to Sizes & Prices' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent('Discard what you typed in this form?');
    fireEvent.click(within(section).getByRole('button', { name: 'Keep editing' }));
    expect(within(section).getByRole('textbox', { name: /Variant Name/ })).toHaveValue('Jumbo');
  });
});
