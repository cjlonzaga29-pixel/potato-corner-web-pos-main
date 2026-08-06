import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ChartSkeleton } from './chart-skeleton';
import { DENSITY_CHART_HEIGHT } from '@/lib/density-tokens';

const { mockUseDensityMode } = vi.hoisted(() => ({
  mockUseDensityMode: vi.fn(),
}));

vi.mock('@/hooks/use-density-mode', () => ({
  useDensityMode: mockUseDensityMode,
}));

describe('ChartSkeleton — density-aware height (Task 200 Phase 5/12)', () => {
  it('matches the compact chart height so the loading -> loaded swap causes no layout shift', () => {
    mockUseDensityMode.mockReturnValue('compact');

    const { container } = render(<ChartSkeleton />);

    const skeleton = container.firstElementChild as HTMLElement;
    expect(skeleton.style.height).toBe(`${DENSITY_CHART_HEIGHT.compact}px`);
  });

  it('matches the comfortable chart height', () => {
    mockUseDensityMode.mockReturnValue('comfortable');

    const { container } = render(<ChartSkeleton />);

    const skeleton = container.firstElementChild as HTMLElement;
    expect(skeleton.style.height).toBe(`${DENSITY_CHART_HEIGHT.comfortable}px`);
  });

  it('an explicit height prop always wins over the density-derived height, matching the chart it stands in for', () => {
    mockUseDensityMode.mockReturnValue('compact');

    const { container } = render(<ChartSkeleton height={314} />);

    const skeleton = container.firstElementChild as HTMLElement;
    expect(skeleton.style.height).toBe('314px');
  });
});
