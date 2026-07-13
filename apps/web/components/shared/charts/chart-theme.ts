/** Shared styling constants so every chart wrapper renders with identical axis/grid/tooltip treatment. */
export const CHART_DEFAULT_HEIGHT = 300;

export const chartGridStroke = 'hsl(var(--border))';

export const chartAxisStyle = { fontSize: 12, fill: 'hsl(var(--muted-foreground))' };

export const chartTooltipContentStyle = {
  backgroundColor: 'hsl(var(--popover))',
  color: 'hsl(var(--popover-foreground))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 'var(--radius)',
  fontSize: 12,
};
