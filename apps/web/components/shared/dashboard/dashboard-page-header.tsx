import type { ReactNode } from 'react';
import { Separator } from '@/components/ui/separator';

interface DashboardPageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /** Branch selector or other existing header actions — never invent new controls here. */
  actions?: ReactNode;
}

/** Compact page header shared by the Admin, Supervisor, and Branch dashboards so all three open with identical structure and spacing. */
export function DashboardPageHeader({ title, subtitle, actions }: DashboardPageHeaderProps) {
  return (
    <div className="app-page-header space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h1 className="app-title font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="app-subtitle truncate text-muted-foreground">{subtitle}</p>}
        </div>
        {actions && <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2.5">{actions}</div>}
      </div>
      <Separator className="bg-border/60" />
    </div>
  );
}
