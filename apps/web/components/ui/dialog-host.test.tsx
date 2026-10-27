import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { Dialog, DialogContent, DialogHost, DialogTitle } from './dialog';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

/**
 * POS-PERF-P39 — inside a DialogHost, a child's dialog is a panel over the
 * host region of the one open modal (no second overlay, no stacked modal),
 * Escape closes only that panel, the content underneath is inert while it is
 * open, and a ConfirmDialog takes the same path. Outside a host, dialogs are
 * unchanged.
 */
afterEach(cleanup);

function Editor({ onConfirm = vi.fn() }: { onConfirm?: () => void }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [inner, setInner] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [active, setActive] = useState(false);
  return (
    <Dialog open>
      <DialogContent>
        <DialogTitle>Editor</DialogTitle>
        <div style={{ position: 'relative' }}>
          <DialogHost container={host} onActiveChange={setActive}>
            <div data-testid="underneath" inert={active}>
              <button type="button" onClick={() => setInner(true)}>
                Add Size
              </button>
              <button type="button" onClick={() => setConfirm(true)}>
                Delete
              </button>
              <Dialog open={inner} onOpenChange={setInner}>
                <DialogContent>
                  <DialogTitle>Add a size</DialogTitle>
                  <input aria-label="Size name" />
                </DialogContent>
              </Dialog>
              <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete this size?" confirmLabel="Delete Size" onConfirm={onConfirm} />
            </div>
            <div ref={setHost} data-testid="host-slot" />
          </DialogHost>
        </div>
      </DialogContent>
    </Dialog>
  );
}

describe('DialogHost (POS-PERF-P39)', () => {
  it('renders a child dialog inside the host region, as the only modal', async () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Size' }));

    const slot = screen.getByTestId('host-slot');
    // POS-PERF-P41 — a labelled section of the editor, not a second dialog.
    await waitFor(() => expect(within(slot).getByRole('region', { name: 'Add a size' })).toBeInTheDocument());
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    // One overlay — the editor's own — and the editor is the only modal dialog.
    expect(document.querySelectorAll('[data-state="open"].fixed.inset-0')).toHaveLength(1);
    // The panel is laid out inside the editor, not as a second fixed, centred modal.
    expect(within(slot).getByRole('region', { name: 'Add a size' })).not.toHaveClass('fixed');
    expect(within(slot).getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.getByTestId('underneath')).toHaveAttribute('inert');
  });

  it('Escape closes the panel only, leaving the editor open and interactive', async () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Size' }));
    const panel = await screen.findByRole('region', { name: 'Add a size' });

    fireEvent.keyDown(within(panel).getByRole('textbox', { name: 'Size name' }), { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Add a size' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Editor' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('underneath')).not.toHaveAttribute('inert'));
  });

  it('hosts ConfirmDialog as a panel too, with the same confirm/cancel behaviour', async () => {
    const onConfirm = vi.fn();
    render(<Editor onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const slot = screen.getByTestId('host-slot');
    const panel = await within(slot).findByRole('alertdialog', { name: 'Delete this size?' });
    expect(screen.queryAllByRole('alertdialog').filter((d) => !slot.contains(d))).toHaveLength(0);

    fireEvent.click(within(panel).getByRole('button', { name: 'Delete Size' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('leaves a dialog outside any host modal, as before', async () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Plain</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(await screen.findByRole('dialog', { name: 'Plain' })).toHaveClass('fixed');
    expect(document.querySelectorAll('[data-state="open"].fixed.inset-0')).toHaveLength(1);
  });
});
