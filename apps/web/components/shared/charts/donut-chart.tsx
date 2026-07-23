'use client';

import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { EmptyState } from '../feedback/empty-state';
import { CHART_DEFAULT_HEIGHT, chartTooltipContentStyle } from './chart-theme';

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
export function DonutChart({ data, height = CHART_DEFAULT_HEIGHT, showLegend = true, centerLabel, animate = true }: DonutChartProps) {
  if (data.length === 0) {
    return <EmptyState title="No data" description="There's nothing to chart yet." />;
  }

  const total = data.reduce((sum, entry) => sum + entry.value, 0);

  return (
    <div className="relative" style={{ height }}>
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
