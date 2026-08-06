import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { BarChart } from './bar-chart';
import { DENSITY_CHART_HEIGHT } from '@/lib/density-tokens';

const { mockUseDensityMode } = vi.hoisted(() => ({
  mockUseDensityMode: vi.fn(),
}));

vi.mock('@/hooks/use-density-mode', () => ({
  useDensityMode: mockUseDensityMode,
}));

const data = [{ label: 'Mon', value: 10 }];
const bars = [{ dataKey: 'value', color: '#000' }];

describe('BarChart — density-aware height (Task 200)', () => {
  it('uses the standard density chart height by default when no explicit height is passed', () => {
    mockUseDensityMode.mockReturnValue('standard');

    const { container } = render(<BarChart data={data} bars={bars} xAxisKey="label" />);

    const wrapper = container.querySelector('.recharts-responsive-container') as HTMLElement;
    expect(wrapper.style.height).toBe(`${DENSITY_CHART_HEIGHT.standard}px`);
  });

  it('shrinks to the compact density chart height on a short-viewport laptop (1366x768-class)', () => {
    mockUseDensityMode.mockReturnValue('compact');

    const { container } = render(<BarChart data={data} bars={bars} xAxisKey="label" />);

    const wrapper = container.querySelector('.recharts-responsive-container') as HTMLElement;
    expect(wrapper.style.height).toBe(`${DENSITY_CHART_HEIGHT.compact}px`);
  });

  it('grows to the comfortable density chart height on a large desktop viewport', () => {
    mockUseDensityMode.mockReturnValue('comfortable');

    const { container } = render(<BarChart data={data} bars={bars} xAxisKey="label" />);

    const wrapper = container.querySelector('.recharts-responsive-container') as HTMLElement;
    expect(wrapper.style.height).toBe(`${DENSITY_CHART_HEIGHT.comfortable}px`);
  });

  it('an explicit height prop always wins over the density-derived height', () => {
    mockUseDensityMode.mockReturnValue('compact');

    const { container } = render(<BarChart data={data} bars={bars} xAxisKey="label" height={275} />);

    const wrapper = container.querySelector('.recharts-responsive-container') as HTMLElement;
    expect(wrapper.style.height).toBe('275px');
  });
});
