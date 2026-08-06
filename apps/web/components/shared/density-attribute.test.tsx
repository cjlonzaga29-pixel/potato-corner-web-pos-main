import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DensityAttribute } from './density-attribute';

const { mockUseDensityMode } = vi.hoisted(() => ({
  mockUseDensityMode: vi.fn(),
}));

vi.mock('@/hooks/use-density-mode', () => ({
  useDensityMode: mockUseDensityMode,
}));

describe('DensityAttribute', () => {
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-density');
  });

  it('renders nothing', () => {
    mockUseDensityMode.mockReturnValue('standard');
    const { container } = render(<DensityAttribute />);
    expect(container).toBeEmptyDOMElement();
  });

  it('sets data-density on <html> to the current density mode', () => {
    mockUseDensityMode.mockReturnValue('compact');
    render(<DensityAttribute />);
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
  });

  it('updates data-density when the resolved mode changes across a re-render', () => {
    mockUseDensityMode.mockReturnValue('standard');
    const { rerender } = render(<DensityAttribute />);
    expect(document.documentElement.getAttribute('data-density')).toBe('standard');

    mockUseDensityMode.mockReturnValue('mobile');
    rerender(<DensityAttribute />);
    expect(document.documentElement.getAttribute('data-density')).toBe('mobile');
  });
});
