'use client';

import { Bar, BarChart as RechartsBarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useDensityMode } from '@/hooks/use-density-mode';
import { DENSITY_CHART_HEIGHT } from '@/lib/density-tokens';
import { EmptyState } from '../feedback/empty-state';
import { chartAxisStyle, chartGridStroke, chartTooltipContentStyle } from './chart-theme';

interface BarSeries {
  dataKey: string;
  color: string;
  name?: string;
}

interface BarChartProps {
  data: Record<string, unknown>[];
  bars: BarSeries[];
  xAxisKey: string;
  height?: number;
  showGrid?: boolean;
  showTooltip?: boolean;
  stacked?: boolean;
  animate?: boolean;
}

/** Wrapper around Recharts BarChart — used for daily revenue and branch comparison charts. */
export function BarChart({
  data,
  bars,
  xAxisKey,
  height,
  showGrid = true,
  showTooltip = true,
  stacked = false,
  animate = true,
}: BarChartProps) {
  const densityMode = useDensityMode();
  const resolvedHeight = height ?? DENSITY_CHART_HEIGHT[densityMode];

  if (data.length === 0) {
    return <EmptyState title="No data" description="There's nothing to chart yet." />;
  }

  return (
    <ResponsiveContainer width="100%" height={resolvedHeight}>
      <RechartsBarChart data={data}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" stroke={chartGridStroke} vertical={false} />}
        <XAxis dataKey={xAxisKey} tick={chartAxisStyle} axisLine={{ stroke: chartGridStroke }} tickLine={false} />
        <YAxis tick={chartAxisStyle} axisLine={false} tickLine={false} />
        {showTooltip && <Tooltip contentStyle={chartTooltipContentStyle} cursor={{ fill: 'hsl(var(--accent))' }} />}
        {bars.length > 1 && <Legend />}
        {bars.map((bar) => (
          <Bar
            key={bar.dataKey}
            dataKey={bar.dataKey}
            name={bar.name ?? bar.dataKey}
            fill={bar.color}
            stackId={stacked ? 'stack' : undefined}
            radius={stacked ? [0, 0, 0, 0] : [4, 4, 0, 0]}
            isAnimationActive={animate}
          />
        ))}
      </RechartsBarChart>
    </ResponsiveContainer>
  );
}
