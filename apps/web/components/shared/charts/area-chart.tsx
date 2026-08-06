'use client';

import { Area, AreaChart as RechartsAreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useDensityMode } from '@/hooks/use-density-mode';
import { DENSITY_CHART_HEIGHT } from '@/lib/density-tokens';
import { EmptyState } from '../feedback/empty-state';
import { chartAxisStyle, chartGridStroke, chartTooltipContentStyle } from './chart-theme';

interface AreaSeries {
  dataKey: string;
  color: string;
  name?: string;
}

interface AreaChartProps {
  data: Record<string, unknown>[];
  areas: AreaSeries[];
  xAxisKey: string;
  height?: number;
  showGrid?: boolean;
  gradient?: boolean;
  animate?: boolean;
}

/** Wrapper around Recharts AreaChart — used for transaction volume trends. */
export function AreaChart({
  data,
  areas,
  xAxisKey,
  height,
  showGrid = true,
  gradient = true,
  animate = true,
}: AreaChartProps) {
  const densityMode = useDensityMode();
  const resolvedHeight = height ?? DENSITY_CHART_HEIGHT[densityMode];

  if (data.length === 0) {
    return <EmptyState title="No data" description="There's nothing to chart yet." />;
  }

  return (
    <ResponsiveContainer width="100%" height={resolvedHeight}>
      <RechartsAreaChart data={data}>
        {gradient && (
          <defs>
            {areas.map((area) => (
              <linearGradient key={area.dataKey} id={`gradient-${area.dataKey}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={area.color} stopOpacity={0.4} />
                <stop offset="95%" stopColor={area.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
        )}
        {showGrid && <CartesianGrid strokeDasharray="3 3" stroke={chartGridStroke} vertical={false} />}
        <XAxis dataKey={xAxisKey} tick={chartAxisStyle} axisLine={{ stroke: chartGridStroke }} tickLine={false} />
        <YAxis tick={chartAxisStyle} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={chartTooltipContentStyle} />
        {areas.map((area) => (
          <Area
            key={area.dataKey}
            type="monotone"
            dataKey={area.dataKey}
            name={area.name ?? area.dataKey}
            stroke={area.color}
            fill={gradient ? `url(#gradient-${area.dataKey})` : area.color}
            fillOpacity={gradient ? 1 : 0.2}
            strokeWidth={2}
            isAnimationActive={animate}
          />
        ))}
      </RechartsAreaChart>
    </ResponsiveContainer>
  );
}
