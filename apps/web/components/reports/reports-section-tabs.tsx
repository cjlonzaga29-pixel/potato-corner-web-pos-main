'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

/**
 * POS-PERF-P52 — Reports navigation: the existing sales/operations reports
 * and Payroll. Plain links (each section is its own route), rendered as a
 * tab strip so Payroll is found where people already look for reports.
 */
export function ReportsSectionTabs({ basePath }: { basePath: '/supervisor/reports' | '/admin/reports' }) {
  const pathname = usePathname();
  const payrollHref = `${basePath}/payroll`;
  const onPayroll = pathname === payrollHref || pathname?.startsWith(`${payrollHref}/`);
  const items = [
    { href: basePath, label: 'Sales & operations', active: !onPayroll },
    { href: payrollHref, label: 'Payroll', active: Boolean(onPayroll) },
  ];
  return (
    <nav aria-label="Report sections" className="flex w-full gap-1 overflow-x-auto rounded-full border border-border/60 bg-muted/40 p-1 sm:w-fit">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          prefetch={false}
          aria-current={item.active ? 'page' : undefined}
          className={cn(
            'flex min-h-10 flex-1 items-center justify-center whitespace-nowrap rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none',
            item.active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
