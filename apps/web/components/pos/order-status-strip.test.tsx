import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { OrderStatusStrip } from './order-status-strip';

afterEach(() => cleanup());

describe('OrderStatusStrip', () => {
  it('renders nothing when there is nothing to show', () => {
    const { container } = render(
      <OrderStatusStrip savingCount={0} needsAttentionCount={0} totalCount={0} onOpenDetails={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the saving count and total, and opens details on click', () => {
    const onOpenDetails = vi.fn();
    render(<OrderStatusStrip savingCount={2} needsAttentionCount={0} totalCount={2} onOpenDetails={onOpenDetails} />);

    expect(screen.getByText(/2 saving/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Orders/ }));
    expect(onOpenDetails).toHaveBeenCalledTimes(1);
  });

  it('surfaces needs-attention count distinctly from saving', () => {
    render(<OrderStatusStrip savingCount={1} needsAttentionCount={1} totalCount={2} onOpenDetails={vi.fn()} />);

    expect(screen.getByText(/1 saving/)).toBeInTheDocument();
    expect(screen.getByText(/1 needs attention/)).toBeInTheDocument();
  });
});
