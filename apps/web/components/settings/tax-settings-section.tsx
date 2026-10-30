'use client';

import { Lock } from 'lucide-react';
import { STATUTORY_DISCOUNT_PERCENT, VAT_RATE_PERCENT, computeSaleTax } from '@potato-corner/shared';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useTaxConfiguration } from '@/hooks/queries/use-settings';

function formatPeso(amount: number): string {
  return `₱${amount.toFixed(2)}`;
}

const EXAMPLE_PRICE = 112;

interface TaxRow {
  label: string;
  value: string;
  meaning: string;
  basis: string;
}

/**
 * POS-PERF-P50 — what VAT checkout applies, where it comes from and what it
 * affects. Read-only for every role: the VAT rate and the PWD/Senior Citizen
 * treatment are statutory, VAT-inclusive pricing is how the POS works, and
 * none of them is a setting. The example is computed with computeSaleTax —
 * the same function checkout runs — so it cannot disagree with a real sale.
 */
export function TaxSettingsSection() {
  const { data: config, isLoading: isFetching, isError } = useTaxConfiguration();
  // A query that has not run yet (no session token) is idle, not loading — never show fallback values as if they were live.
  const isLoading = isFetching || (config === undefined && !isError);

  const vatRate = config?.vatRatePercent ?? VAT_RATE_PERCENT;
  const statutory = config?.statutoryDiscountPercent ?? STATUTORY_DISCOUNT_PERCENT;
  const rates = config?.discountRates ?? { pwd: statutory, senior_citizen: statutory, employee: 20 };
  const line = [{ lineTotal: EXAMPLE_PRICE, quantity: 1, vatableCapAmount: null }];
  const ordinary = computeSaleTax(EXAMPLE_PRICE, line, null, rates);
  const exempt = computeSaleTax(EXAMPLE_PRICE, line, 'senior_citizen', { ...rates, senior_citizen: statutory });
  const employee = computeSaleTax(EXAMPLE_PRICE, line, 'employee', rates);
  const exclusive = Math.round((EXAMPLE_PRICE / (1 + vatRate / 100)) * 100) / 100;

  const rows: TaxRow[] = [
    {
      label: 'VAT rate',
      value: `${vatRate}%`,
      meaning: 'Applied to every VATable sale.',
      basis: 'Set by law (NIRC §106, as amended by RA 10963)',
    },
    {
      label: 'Menu prices',
      value: 'Include VAT',
      meaning: `The price shown is what the customer pays. VAT is the ${vatRate}/${100 + vatRate} share of it, not added on top.`,
      basis: 'How the POS works',
    },
    {
      label: 'PWD / Senior Citizen',
      value: `${statutory}% off, VAT-exempt`,
      meaning: `VAT is removed first, the ${statutory}% comes off the price without VAT, and no VAT is charged.`,
      basis: 'Set by law (RA 9994 §4(a); RA 10754)',
    },
    {
      label: 'Employee discount',
      value: `${rates.employee}%`,
      meaning: 'Comes off the VAT-inclusive price; the rest still includes VAT. Change it in Discount Settings below.',
      basis: 'Business choice',
    },
    {
      label: 'Product promotions',
      value: 'Per product',
      meaning: 'Same as the employee discount. Never combined with a PWD, Senior Citizen or Employee discount.',
      basis: 'Business choice (Promotions page)',
    },
    {
      label: 'VAT cap (some sizes)',
      value: 'Per product size',
      meaning: 'If a size has a VATable cap, the part of its price above the cap is non-VATable: not discounted and not taxed.',
      basis: 'Product setup',
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          VAT &amp; Tax
          <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
            <Lock className="h-3 w-3" aria-hidden="true" />
            Read-only
          </span>
        </CardTitle>
        <CardDescription>
          How checkout calculates VAT. Applies to every branch and to checkout totals, receipts and reports. These values are set by
          law or by how the POS works, so they change only with a software update. Past sales always keep the amounts they were rung
          with.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <Skeleton className="h-40 w-full" />}
        {isError && <p className="text-sm text-destructive">Failed to load the tax configuration. Showing this app version&apos;s values.</p>}
        {config === null && (
          <p className="text-sm text-muted-foreground">The server does not report its tax configuration yet. Showing this app version&apos;s values.</p>
        )}
        {config?.statutoryRateMismatch && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
            The saved PWD/Senior Citizen discount ({rates.pwd}% / {rates.senior_citizen}%) is not the {statutory}% required by law, and
            checkout is using it. A Super Admin or Supervisor should restore it to {statutory}% in Discount Settings below.
          </p>
        )}

        {!isLoading && (
          <>
            <dl className="divide-y rounded-md border" data-testid="tax-settings-rows">
              {rows.map((row) => (
                <div key={row.label} className="grid gap-1 p-3 sm:grid-cols-[10rem_9rem_1fr] sm:gap-3">
                  <dt className="text-sm font-medium">{row.label}</dt>
                  <dd className="text-sm font-semibold tabular-nums">{row.value}</dd>
                  <dd className="text-xs text-muted-foreground">
                    {row.meaning} <span className="font-medium text-foreground/80">{row.basis}.</span>
                  </dd>
                </div>
              ))}
            </dl>

            <div className="space-y-2">
              <h3 className="text-sm font-medium">Example: one item priced {formatPeso(EXAMPLE_PRICE)}</h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] text-xs" data-testid="tax-example">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1 pr-2 font-medium">Sale</th>
                      <th className="py-1 pr-2 text-right font-medium">Discount</th>
                      <th className="py-1 pr-2 text-right font-medium">VAT</th>
                      <th className="py-1 text-right font-medium">Customer pays</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    <tr className="border-t">
                      <td className="py-1 pr-2">Ordinary (VATable {formatPeso(exclusive)} + VAT)</td>
                      <td className="py-1 pr-2 text-right">{formatPeso(ordinary.discountAmount)}</td>
                      <td className="py-1 pr-2 text-right">{formatPeso(ordinary.vatAmount)}</td>
                      <td className="py-1 text-right font-semibold">{formatPeso(ordinary.totalAmount)}</td>
                    </tr>
                    <tr className="border-t">
                      <td className="py-1 pr-2">PWD / Senior Citizen (VAT-exempt)</td>
                      <td className="py-1 pr-2 text-right">-{formatPeso(exempt.discountAmount)}</td>
                      <td className="py-1 pr-2 text-right">{formatPeso(exempt.vatAmount)}</td>
                      <td className="py-1 text-right font-semibold">{formatPeso(exempt.totalAmount)}</td>
                    </tr>
                    <tr className="border-t">
                      <td className="py-1 pr-2">Employee ({rates.employee}%)</td>
                      <td className="py-1 pr-2 text-right">-{formatPeso(employee.discountAmount)}</td>
                      <td className="py-1 pr-2 text-right">{formatPeso(employee.vatAmount)}</td>
                      <td className="py-1 text-right font-semibold">{formatPeso(employee.totalAmount)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
