import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80',
        secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80',
        outline: 'text-foreground',
        /** Status variants — used via the StatusBadge component (apps/web/components/shared/status-badge.tsx) rather than referenced directly. */
        active: 'border-transparent bg-success/15 text-success dark:bg-success/20 dark:text-success',
        inactive: 'border-transparent bg-muted text-muted-foreground',
        warning: 'border-transparent bg-warning/15 text-warning dark:bg-warning/20 dark:text-warning',
        critical: 'border-transparent bg-destructive/15 text-destructive dark:bg-destructive/20 dark:text-destructive',
        pending: 'border-transparent bg-info/15 text-info dark:bg-info/20 dark:text-info',
        offline: 'border-transparent bg-accent/15 text-accent dark:bg-accent/20 dark:text-accent',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
