import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  /**
   * Task 209.8 (compact POS redesign) — a much tighter version of the same
   * icon+title+description treatment for space-constrained regions (the POS
   * cart panel, the product grid's "no results" state) where the default
   * `py-16` block would eat most of a ~30%-width cart column. Defaults to
   * `false` so every one of this component's other 60+ call sites (empty
   * tables, empty inventory lists, dashboards, reports, etc.) renders
   * byte-for-byte identically to before this task.
   */
  compact?: boolean;
}

/** Consistent empty-state treatment for empty tables, empty inventory lists, "no transactions yet", etc. */
export function EmptyState({ icon: Icon = Inbox, title, description, action, compact = false }: EmptyStateProps) {
  return (
    <div
      className={
        compact
          ? 'flex flex-col items-center justify-center gap-2 px-4 py-6 text-center'
          : 'flex flex-col items-center justify-center gap-3 px-6 py-16 text-center'
      }
    >
      <div
        className={
          compact
            ? 'flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground'
            : 'flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground'
        }
      >
        <Icon className={compact ? 'h-4 w-4' : 'h-6 w-6'} aria-hidden="true" />
      </div>
      <div className={compact ? 'space-y-0.5' : 'space-y-1'}>
        <p className="text-sm font-medium">{title}</p>
        {description && <p className={compact ? 'text-xs text-muted-foreground' : 'text-sm text-muted-foreground'}>{description}</p>}
      </div>
      {action}
    </div>
  );
}
