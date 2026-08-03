import type { LucideIcon } from 'lucide-react';
import { Banknote, Smartphone, Wallet, CreditCard } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatCurrency } from '@/lib/utils';
import type { PaymentBreakdown } from '@/hooks/queries/use-branches';

type PaymentMethodKey = keyof PaymentBreakdown;

const METHOD_ORDER: PaymentMethodKey[] = ['cash', 'gcash', 'maya', 'other'];

const METHOD_ICON: Record<PaymentMethodKey, LucideIcon> = {
  cash: Banknote,
  gcash: Smartphone,
  maya: Wallet,
  other: CreditCard,
};

const DEFAULT_LABEL: Record<PaymentMethodKey, string> = {
  cash: 'Cash',
  gcash: 'GCash',
  maya: 'Maya',
  other: 'Other',
};

interface PaymentMethodGridProps {
  breakdown: PaymentBreakdown | undefined;
  isLoading: boolean;
  /** Overrides a method's default label (e.g. the Admin dashboard's longstanding "PayMaya" copy). */
  labels?: Partial<Record<PaymentMethodKey, string>>;
  /** Shows the per-method transaction count under the amount. Off by default to keep the tile compact. */
  showCount?: boolean;
  className?: string;
}

/**
 * Shared "equal metric tiles" treatment for today's payment-method split —
 * used by both the Admin (org-wide) and Branch (single-branch) dashboards so
 * Payment Collection reads identically everywhere instead of one being a
 * plain list and the other a bare text grid.
 */
export function PaymentMethodGrid({ breakdown, isLoading, labels, showCount = false, className }: PaymentMethodGridProps) {
  return (
    <div className={cn('grid grid-cols-2 gap-2.5', className)}>
      {METHOD_ORDER.map((key) => {
        const Icon = METHOD_ICON[key];
        const label = labels?.[key] ?? DEFAULT_LABEL[key];
        return (
          <div key={key} className="flex items-center gap-2.5 rounded-lg bg-muted/40 px-3 py-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
              {isLoading ? (
                <Skeleton className="mt-1 h-4 w-14" />
              ) : (
                <>
                  <p className="truncate text-sm font-semibold tabular-nums">{formatCurrency(breakdown?.[key]?.total ?? 0)}</p>
                  {showCount && <p className="truncate text-[11px] text-muted-foreground">{breakdown?.[key]?.count ?? 0} txns</p>}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
