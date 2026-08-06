'use client';

import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { useDensityMode } from '@/hooks/use-density-mode';
import { DENSITY_CHART_HEIGHT } from '@/lib/density-tokens';
import { EmptyState } from '../feedback/empty-state';
import { chartTooltipContentStyle } from './chart-theme';

interface DonutDatum {
  name: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  data: DonutDatum[];
  height?: number;
  showLegend?: boolean;
  centerLabel?: string;
  animate?: boolean;
}

/** Wrapper around Recharts PieChart configured as a donut — used for payment method breakdown and category performance. */
export function DonutChart({ data, height, showLegend = true, centerLabel, animate = true }: DonutChartProps) {
  const densityMode = useDensityMode();
  const resolvedHeight = height ?? DENSITY_CHART_HEIGHT[densityMode];

  if (data.length === 0) {
    return <EmptyState title="No data" description="There's nothing to chart yet." />;
  }

  const total = data.reduce((sum, entry) => sum + entry.value, 0);

  return (
    <div className="relative" style={{ height: resolvedHeight }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="60%"
            outerRadius="85%"
            paddingAngle={2}
            isAnimationActive={animate}
          >
            {data.map((entry) => (
              <Cell key={entry.name} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip contentStyle={chartTooltipContentStyle} />
          {showLegend && <Legend />}
        </PieChart>
      </ResponsiveContainer>
      {centerLabel && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-bold">{total.toLocaleString()}</span>
          <span className="text-xs text-muted-foreground">{centerLabel}</span>
        </div>
      )}
    </div>
  );
}
