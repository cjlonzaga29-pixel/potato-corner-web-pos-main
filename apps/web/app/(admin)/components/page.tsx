'use client';

import { useEffect, useState } from 'react';
import { notFound } from 'next/navigation';
import { DollarSign, Package, ShoppingBag, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';

import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { PageLoader } from '@/components/shared/feedback/page-loader';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { NotFoundState } from '@/components/shared/feedback/not-found-state';
import { StatusBadge } from '@/components/shared/status-badge';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { CopyButton } from '@/components/shared/copy-button';

import { CurrencyInput } from '@/components/shared/forms/currency-input';
import { DenominationInput, type DenominationEntry } from '@/components/shared/forms/denomination-input';
import { SearchInput } from '@/components/shared/forms/search-input';

import { DataTable, createStatusColumn, createCurrencyColumn, createDateColumn } from '@/components/shared/data-table';
import type { ColumnDef } from '@tanstack/react-table';

import { LineChart } from '@/components/shared/charts/line-chart';
import { BarChart } from '@/components/shared/charts/bar-chart';
import { AreaChart } from '@/components/shared/charts/area-chart';
import { DonutChart } from '@/components/shared/charts/donut-chart';
import { KpiCard } from '@/components/shared/charts/kpi-card';

interface SampleProduct {
  id: string;
  name: string;
  status: string;
  price: number;
  updatedAt: string;
}

const SAMPLE_PRODUCTS: SampleProduct[] = [
  { id: '1', name: 'Classic Cheese', status: 'active', price: 65, updatedAt: '2026-01-05' },
  { id: '2', name: 'Sour Cream', status: 'active', price: 65, updatedAt: '2026-01-04' },
  { id: '3', name: 'BBQ Twist', status: 'temporarily_unavailable', price: 70, updatedAt: '2025-12-20' },
  { id: '4', name: 'Limited Edition Ube', status: 'discontinued', price: 80, updatedAt: '2025-11-01' },
];

const SAMPLE_COLUMNS: ColumnDef<SampleProduct>[] = [
  { accessorKey: 'name', header: 'Name' },
  createStatusColumn<SampleProduct>('status', 'Status', 'product'),
  createCurrencyColumn<SampleProduct>('price', 'Price'),
  createDateColumn<SampleProduct>('updatedAt', 'Updated'),
];

const SAMPLE_LINE_DATA = [
  { hour: '9am', sales: 1200 },
  { hour: '11am', sales: 2100 },
  { hour: '1pm', sales: 3400 },
  { hour: '3pm', sales: 2800 },
  { hour: '5pm', sales: 3900 },
  { hour: '7pm', sales: 4600 },
];

const SAMPLE_BAR_DATA = [
  { day: 'Mon', revenue: 12000, cost: 4000 },
  { day: 'Tue', revenue: 15000, cost: 4500 },
  { day: 'Wed', revenue: 9000, cost: 3200 },
  { day: 'Thu', revenue: 17000, cost: 5000 },
  { day: 'Fri', revenue: 21000, cost: 6000 },
];

const SAMPLE_DONUT_DATA = [
  { name: 'Cash', value: 62, color: '#EAB308' },
  { name: 'GCash', value: 38, color: '#3B82F6' },
];

/**
 * Development-only showcase of every shared component and its variants —
 * helpful for visually verifying components before they're wired into
 * real features. Not linked in production navigation, and hard-blocked
 * outside development so it can never be reached in a production build.
 */
export default function ComponentShowcasePage() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  const [showPageLoader, setShowPageLoader] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dangerConfirmOpen, setDangerConfirmOpen] = useState(false);
  const [currencyValue, setCurrencyValue] = useState<number>(150);
  const [searchValue, setSearchValue] = useState('');
  const [denominations, setDenominations] = useState<DenominationEntry[]>([]);
  const [denominationTotal, setDenominationTotal] = useState(0);

  useEffect(() => {
    if (!showPageLoader) return;
    const timeout = setTimeout(() => setShowPageLoader(false), 2000);
    return () => clearTimeout(timeout);
  }, [showPageLoader]);

  return (
    <div className="space-y-8 pb-24">
      <div>
        <h1 className="text-2xl font-bold">Component Showcase</h1>
        <p className="text-sm text-muted-foreground">Development-only — verifies every shared component renders correctly.</p>
      </div>

      <Tabs defaultValue="buttons">
        <TabsList className="flex-wrap">
          <TabsTrigger value="buttons">Buttons</TabsTrigger>
          <TabsTrigger value="badges">Badges</TabsTrigger>
          <TabsTrigger value="forms">Forms</TabsTrigger>
          <TabsTrigger value="table">DataTable</TabsTrigger>
          <TabsTrigger value="charts">Charts</TabsTrigger>
          <TabsTrigger value="kpi">KPI Cards</TabsTrigger>
          <TabsTrigger value="feedback">Feedback</TabsTrigger>
        </TabsList>

        <TabsContent value="buttons" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Button variants</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              <Button variant="default">Default</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="link">Link</Button>
              <Button variant="destructive">Destructive</Button>
              <Button variant="danger">Danger</Button>
              <Button variant="ghost-yellow">Ghost Yellow</Button>
              <Button variant="pos">POS (56px)</Button>
              <Button disabled>Disabled</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Sonner toast</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              <Button onClick={() => toast.success('Saved successfully')}>Success toast</Button>
              <Button variant="outline" onClick={() => toast.error('Something went wrong')}>
                Error toast
              </Button>
              <Button variant="outline" onClick={() => toast.info('Heads up')}>
                Info toast
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="badges" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Badge variants</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              <Badge variant="active">Active</Badge>
              <Badge variant="inactive">Inactive</Badge>
              <Badge variant="warning">Warning</Badge>
              <Badge variant="critical">Critical</Badge>
              <Badge variant="pending">Pending</Badge>
              <Badge variant="offline">Offline</Badge>
              <Badge variant="default">Default</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="outline">Outline</Badge>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>StatusBadge</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              <StatusBadge status="active" type="product" />
              <StatusBadge status="temporarily_unavailable" type="product" />
              <StatusBadge status="discontinued" type="product" />
              <StatusBadge status="flagged" type="shift" />
              <StatusBadge status="out_of_stock" type="inventory" />
              <StatusBadge status="escalated" type="fraud" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Copy button</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 text-sm">PC-BR01-20260110-000123</code>
              <CopyButton value="PC-BR01-20260110-000123" label="Copy transaction number" />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="forms" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Currency input</CardTitle>
            </CardHeader>
            <CardContent className="max-w-xs space-y-2">
              <CurrencyInput value={currencyValue} onChange={setCurrencyValue} id="currency-demo" name="currency-demo" aria-label="Currency Input" />
              <p className="text-xs text-muted-foreground">Numeric value: {currencyValue}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Search input (debounced)</CardTitle>
            </CardHeader>
            <CardContent className="max-w-xs space-y-2">
              <SearchInput value={searchValue} onChange={setSearchValue} placeholder="Search products..." />
              <p className="text-xs text-muted-foreground">Debounced value: {searchValue || '(empty)'}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Denomination input (cash count)</CardTitle>
            </CardHeader>
            <CardContent className="max-w-sm">
              <DenominationInput
                value={denominations}
                onChange={(entries, total) => {
                  setDenominations(entries);
                  setDenominationTotal(total);
                }}
              />
              <p className="mt-2 text-xs text-muted-foreground">Emitted total: {denominationTotal}</p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="table" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>DataTable</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={SAMPLE_COLUMNS}
                data={SAMPLE_PRODUCTS}
                pagination={{ pageIndex: 0, pageSize: 10 }}
                onPaginationChange={() => undefined}
                rowCount={SAMPLE_PRODUCTS.length}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="charts" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Line chart</CardTitle>
            </CardHeader>
            <CardContent>
              <LineChart data={SAMPLE_LINE_DATA} lines={[{ dataKey: 'sales', color: '#EAB308', name: 'Sales' }]} xAxisKey="hour" height={240} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Bar chart</CardTitle>
            </CardHeader>
            <CardContent>
              <BarChart
                data={SAMPLE_BAR_DATA}
                bars={[
                  { dataKey: 'revenue', color: '#EAB308', name: 'Revenue' },
                  { dataKey: 'cost', color: '#94A3B8', name: 'Cost' },
                ]}
                xAxisKey="day"
                height={240}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Area chart</CardTitle>
            </CardHeader>
            <CardContent>
              <AreaChart data={SAMPLE_LINE_DATA} areas={[{ dataKey: 'sales', color: '#EAB308', name: 'Volume' }]} xAxisKey="hour" height={240} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Donut chart</CardTitle>
            </CardHeader>
            <CardContent>
              <DonutChart data={SAMPLE_DONUT_DATA} height={240} centerLabel="Payments" />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="kpi" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard title="Today's Sales" value={48250} prefix="₱" previousValue={41200} icon={DollarSign} />
            <KpiCard title="Transactions" value={312} previousValue={340} trendLabel="vs yesterday" icon={ShoppingBag} />
            <KpiCard title="Active Employees" value={18} icon={Users} trend="neutral" />
            <KpiCard title="Low Stock Items" value={5} previousValue={2} icon={Package} />
            <KpiCard title="Loading example" value={0} isLoading />
          </div>
        </TabsContent>

        <TabsContent value="feedback" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Loading spinner</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center gap-6">
              <LoadingSpinner size="sm" />
              <LoadingSpinner size="md" />
              <LoadingSpinner size="lg" />
              <Button variant="outline" onClick={() => setShowPageLoader(true)}>
                Show page loader (2s)
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Empty state</CardTitle>
            </CardHeader>
            <CardContent>
              <EmptyState title="No transactions yet" description="Completed sales will show up here." />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Error state</CardTitle>
            </CardHeader>
            <CardContent>
              <ErrorState retry={() => toast.info('Retry clicked')} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Not found state</CardTitle>
            </CardHeader>
            <CardContent>
              <NotFoundState title="Product not found" backHref="/admin/products" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Confirm dialog</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              <Button variant="outline" onClick={() => setConfirmOpen(true)}>
                Open confirm dialog
              </Button>
              <Button variant="danger" onClick={() => setDangerConfirmOpen(true)}>
                Open danger confirm dialog
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {showPageLoader && <PageLoader message="Loading example..." />}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Confirm action"
        description="This is a standard confirmation dialog."
        onConfirm={() => {
          toast.success('Confirmed');
        }}
      />
      <ConfirmDialog
        open={dangerConfirmOpen}
        onOpenChange={setDangerConfirmOpen}
        title="Delete product?"
        description="This action cannot be undone."
        variant="danger"
        confirmLabel="Delete"
        onConfirm={async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          toast.success('Deleted');
        }}
      />
    </div>
  );
}
