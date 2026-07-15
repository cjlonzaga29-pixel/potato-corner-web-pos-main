'use client';

import { CartesianGrid, Legend, Line, LineChart as RechartsLineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { EmptyState } from '../feedback/empty-state';
import { CHART_DEFAULT_HEIGHT, chartAxisStyle, chartGridStroke, chartTooltipContentStyle } from './chart-theme';

interface LineSeries {
  dataKey: string;
  color: string;
  name?: string;
}

interface LineChartProps {
  data: Record<string, unknown>[];
  lines: LineSeries[];
  xAxisKey: string;
  height?: number;
  showGrid?: boolean;
  showTooltip?: boolean;
  showLegend?: boolean;
}

/** Wrapper around Recharts LineChart — used for hourly sales and trend charts on dashboards. */
export function LineChart({
  data,
  lines,
  xAxisKey,
  height = CHART_DEFAULT_HEIGHT,
  showGrid = true,
  showTooltip = true,
  showLegend = false,
}: LineChartProps) {
  if (data.length === 0) {
    return <EmptyState title="No data" description="There's nothing to chart yet." />;
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsLineChart data={data}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" stroke={chartGridStroke} vertical={false} />}
        <XAxis dataKey={xAxisKey} tick={chartAxisStyle} axisLine={{ stroke: chartGridStroke }} tickLine={false} />
        <YAxis tick={chartAxisStyle} axisLine={false} tickLine={false} />
        {showTooltip && <Tooltip contentStyle={chartTooltipContentStyle} />}
        {showLegend && <Legend />}
        {lines.map((line) => (
          <Line
            key={line.dataKey}
            type="monotone"
            dataKey={line.dataKey}
            name={line.name ?? line.dataKey}
            stroke={line.color}
            strokeWidth={2}
            dot={false}
          />
        ))}
      </RechartsLineChart>
    </ResponsiveContainer>
  );
}
