'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import { useFlavor } from '@/hooks/queries/use-flavors';
import { FlavorColorSwatch } from '@/components/admin/flavors/flavor-color-swatch';
import { EditFlavorDialog } from '@/components/admin/flavors/edit-flavor-dialog';
import { BranchFlavorAvailabilityTable } from '@/components/admin/flavors/branch-flavor-availability-table';

interface FlavorDetailPageProps {
  params: Promise<{ flavorId: string }>;
}

export default function FlavorDetailPage({ params }: FlavorDetailPageProps) {
  const { flavorId } = use(params);
  const { data: flavor, isLoading, isError, refetch } = useFlavor(flavorId);
  const [editOpen, setEditOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (isError || !flavor) {
    return <ErrorState title="Flavor not found" retry={() => void refetch()} />;
  }

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/admin/flavors">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to flavors
        </Link>
      </Button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <FlavorColorSwatch colorHex={flavor.color_hex} className="h-8 w-8" />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{flavor.name}</h1>
              <Badge variant={flavor.is_active ? 'active' : 'inactive'}>{flavor.is_active ? 'Active' : 'Inactive'}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{flavor.color_hex}</p>
          </div>
        </div>
        <Button variant="outline" onClick={() => setEditOpen(true)}>
          Edit Flavor
        </Button>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="availability">Branch Availability</TabsTrigger>
          <TabsTrigger value="variants">Linked Variants</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Flavor Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <p className="text-muted-foreground">Description</p>
                <p className="font-medium">{flavor.description ?? 'No description'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Color</p>
                <p className="flex items-center gap-2 font-medium">
                  <FlavorColorSwatch colorHex={flavor.color_hex} />
                  {flavor.color_hex}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Display Order</p>
                <p className="font-medium">{flavor.display_order ?? '—'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Status</p>
                <p className="font-medium">{flavor.is_active ? 'Active' : 'Inactive'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Created / Updated</p>
                <p className="font-medium">
                  {formatDateTime(flavor.created_at)} / {formatDateTime(flavor.updated_at)}
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="availability" className="space-y-4">
          <BranchFlavorAvailabilityTable flavorId={flavorId} />
        </TabsContent>

        <TabsContent value="variants" className="space-y-4">
          {flavor.linked_variants.length === 0 ? (
            <EmptyState title="Not linked to any variant" description="Link this flavor to a product variant to start using it." />
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Variant</TableHead>
                    <TableHead>Price Premium</TableHead>
                    <TableHead>Available</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {flavor.linked_variants.map((link) => (
                    <TableRow key={link.product_variant_id}>
                      <TableCell>{link.product_name}</TableCell>
                      <TableCell>
                        {link.variant_name} ({link.size_label})
                      </TableCell>
                      <TableCell>{formatCurrency(link.price_premium)}</TableCell>
                      <TableCell>
                        <Badge variant={link.is_available ? 'active' : 'inactive'}>{link.is_available ? 'Available' : 'Unavailable'}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <EditFlavorDialog open={editOpen} onOpenChange={setEditOpen} flavor={flavor} />
    </div>
  );
}
