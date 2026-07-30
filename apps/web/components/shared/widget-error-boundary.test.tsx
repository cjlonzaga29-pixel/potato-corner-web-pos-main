import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WidgetErrorBoundary } from './widget-error-boundary';

function Boom(): never {
  throw new Error('widget render crash');
}

describe('WidgetErrorBoundary', () => {
  it('replaces only the crashing subtree with a labeled fallback, leaving siblings intact', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <div>
        <WidgetErrorBoundary label="Sales Trend">
          <Boom />
        </WidgetErrorBoundary>
        <div data-testid="sibling">Unaffected sibling widget</div>
      </div>,
    );

    expect(screen.getByText('Sales Trend failed to load')).toBeInTheDocument();
    expect(screen.getByTestId('sibling')).toHaveTextContent('Unaffected sibling widget');

    vi.restoreAllMocks();
  });

  it('renders children normally when there is no error', () => {
    render(
      <WidgetErrorBoundary label="Sales Trend">
        <div>content</div>
      </WidgetErrorBoundary>,
    );

    expect(screen.getByText('content')).toBeInTheDocument();
  });
});
