import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { CreateOptionGroupDialog } from './create-option-group-dialog';

const { mockUseCreateProductOptionGroup } = vi.hoisted(() => ({
  mockUseCreateProductOptionGroup: vi.fn(),
}));

vi.mock('@/hooks/queries/use-product-options', () => ({
  useCreateProductOptionGroup: mockUseCreateProductOptionGroup,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fillRequiredFields() {
  fireEvent.change(screen.getByPlaceholderText('flavor'), { target: { value: 'flavor' } });
  fireEvent.change(screen.getByPlaceholderText('Flavor'), { target: { value: 'Flavor' } });
}

describe('CreateOptionGroupDialog — POS Button Label', () => {
  it('displays the POS Button Label field', () => {
    mockUseCreateProductOptionGroup.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

    render(<CreateOptionGroupDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByText('POS Button Label')).toBeInTheDocument();
    expect(screen.getByText('This label appears in the POS. Leave blank to use the group name.')).toBeInTheDocument();
  });

  it('sends the entered POS Button Label value, trimmed', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseCreateProductOptionGroup.mockReturnValue({ mutateAsync, isPending: false });

    render(<CreateOptionGroupDialog open onOpenChange={vi.fn()} />);

    fillRequiredFields();
    fireEvent.change(screen.getByPlaceholderText('e.g. Fries Add-ons'), { target: { value: '  Fries Add-ons  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Option Group' }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ pos_button_label: 'Fries Add-ons' }),
      ),
    );
  });

  it('sends null when the POS Button Label is left blank', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseCreateProductOptionGroup.mockReturnValue({ mutateAsync, isPending: false });

    render(<CreateOptionGroupDialog open onOpenChange={vi.fn()} />);

    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: 'Create Option Group' }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ pos_button_label: null }),
      ),
    );
  });

  it('leaves other fields unchanged in the create payload', async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseCreateProductOptionGroup.mockReturnValue({ mutateAsync, isPending: false });

    render(<CreateOptionGroupDialog open onOpenChange={vi.fn()} />);

    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: 'Create Option Group' }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        code: 'flavor',
        name: 'Flavor',
        description: undefined,
        pos_button_label: null,
        selection_type: 'SINGLE',
        min_selections: 0,
        max_selections: undefined,
        required: false,
        is_active: true,
      }),
    );
  });
});
