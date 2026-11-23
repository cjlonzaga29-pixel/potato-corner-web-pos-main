'use client';

import Link from 'next/link';
import { MoreHorizontal } from 'lucide-react';
import type { ProductBranchView, ProductResponse } from '@potato-corner/shared';
import { productTypeLabel } from '@/lib/product-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ProductImageThumbnail } from '@/components/admin/products/product-image-thumbnail';

export type ProductRowAction = 'edit' | 'publish' | 'continue' | 'deactivate' | 'archive' | 'delete';

interface ProductListRowProps {
  product: ProductResponse;
  view: ProductBranchView;
  branchName: string;
  /** Edit in place, publish, archive and delete need authority over every branch the product is set up for. */
  canEdit: boolean;
  /** Deactivating at the selected branch needs only an assignment there. */
  canDeactivate: boolean;
  onAction: (action: ProductRowAction, product: ProductResponse) => void;
}

const MAX_BRANCH_CHIPS = 3;

function statusFor(product: ProductResponse, view: ProductBranchView, branchName: string): { label: string; variant: 'active' | 'outline' | 'warning' | 'pending' | 'inactive' } {
  if (view === 'drafts') return { label: 'Draft', variant: 'pending' };
  if (view === 'active') return { label: 'On POS', variant: 'active' };
  if (product.status === 'archived') return { label: 'Archived', variant: 'inactive' };
  if (product.status === 'discontinued') return { label: 'Discontinued', variant: 'inactive' };
  if (product.status === 'temporarily_unavailable') return { label: 'Temporarily unavailable', variant: 'warning' };
  return { label: `Off POS at ${branchName}`, variant: 'outline' };
}

/**
 * POS-PERF-P39 — one compact row of the supervisor Products list. Only the
 * product name is a link (to its product page) and every action is its own
 * button, so nothing interactive is nested inside another.
 *
 * Product permanent delete — every row has the same actions in the same
 * order and wording: View (always), Edit (Continue Setup for a draft),
 * Activate or Deactivate at the selected branch, Permanently Delete, then
 * More (Archive). Actions the supervisor can't take are left out, and the
 * row says why: a product set up for a branch outside their assignment is
 * view only (the server enforces the same scope), and Create Branch Copy on
 * its product page is the way to change it for their own branch.
 */
export function ProductListRow({ product, view, branchName, canEdit, canDeactivate, onAction }: ProductListRowProps) {
  const status = statusFor(product, view, branchName);
  const typeLabel = `${productTypeLabel(product)}${product.product_type?.is_active === false ? ' (inactive)' : ''}`;
  const branches = product.branches ?? [];
  const lifecycleClosed = product.status === 'archived' || product.status === 'discontinued';
  const readOnlyReason = !canEdit ? 'Set up for a branch outside your assignment — view only.' : null;
  const canActivate = view === 'inactive' && canEdit && !lifecycleClosed;

  return (
    <li
      className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-3 py-3 sm:px-4 md:grid-cols-[3rem_minmax(0,2fr)_6.5rem_minmax(0,1fr)_minmax(0,1.6fr)_9rem_auto] md:items-center"
      data-testid="product-row"
      data-product-id={product.id}
    >
      <ProductImageThumbnail hasImage={product.has_image} imageUrl={product.image_url} productName={product.name} className="h-12 w-12" />

      <div className="min-w-0">
        <Link href={`/supervisor/products/${product.id}`} className="block truncate font-medium hover:underline" title={product.name}>
          {product.name}
        </Link>
        <p className="truncate text-xs text-muted-foreground md:hidden">
          {typeLabel} · {product.category_name ?? 'Uncategorized'}
        </p>
        {readOnlyReason && <p className="text-xs text-muted-foreground">{readOnlyReason}</p>}
      </div>

      <p className="hidden truncate text-sm text-muted-foreground md:block" data-testid="product-row-type" title={typeLabel}>
        {typeLabel}
      </p>

      <p className="hidden truncate text-sm text-muted-foreground md:block">{product.category_name ?? 'Uncategorized'}</p>

      <div className="col-start-2 flex min-w-0 flex-wrap gap-1 md:col-start-auto" aria-label="Branches">
        {branches.length === 0 && <span className="text-xs text-muted-foreground">No branches</span>}
        {branches.slice(0, MAX_BRANCH_CHIPS).map((branch) => (
          <Badge key={branch.branch_id} variant={branch.is_available ? 'active' : 'outline'} className="max-w-[10rem] truncate font-normal" title={`${branch.branch_name}: ${branch.is_available ? 'on POS' : 'not on POS'}`}>
            {branch.branch_name}
            <span className="sr-only">{branch.is_available ? ' (on POS)' : ' (not on POS)'}</span>
          </Badge>
        ))}
        {branches.length > MAX_BRANCH_CHIPS && (
          <Badge variant="outline" className="font-normal" title={branches.slice(MAX_BRANCH_CHIPS).map((b) => b.branch_name).join(', ')}>
            +{branches.length - MAX_BRANCH_CHIPS} more
          </Badge>
        )}
      </div>

      <div className="col-start-2 md:col-start-auto">
        <Badge variant={status.variant} data-testid="product-row-status">
          {status.label}
        </Badge>
      </div>

      <div className="col-start-2 flex flex-wrap items-center gap-2 md:col-start-auto md:justify-end" aria-label={`Actions for ${product.name}`} role="group">
        <Button size="sm" variant="outline" asChild>
          <Link href={`/supervisor/products/${product.id}`}>View</Link>
        </Button>
        {view === 'drafts' && canEdit && (
          <Button size="sm" onClick={() => onAction('continue', product)}>
            Continue Setup
          </Button>
        )}
        {view !== 'drafts' && canEdit && !lifecycleClosed && (
          <Button size="sm" variant="outline" onClick={() => onAction('edit', product)}>
            Edit
          </Button>
        )}
        {view === 'active' && canDeactivate && (
          <Button size="sm" variant="outline" onClick={() => onAction('deactivate', product)}>
            Deactivate
          </Button>
        )}
        {canActivate && (
          <Button size="sm" variant="outline" onClick={() => onAction('publish', product)} title={`Publish at ${branchName}`}>
            Activate
          </Button>
        )}
        {canEdit && (
          <Button size="sm" variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => onAction('delete', product)}>
            Permanently Delete
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" aria-label={`More actions for ${product.name}`}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {view === 'drafts' && canEdit && <DropdownMenuItem onSelect={() => onAction('edit', product)}>Edit in popup</DropdownMenuItem>}
            {!canEdit ? (
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground" data-testid="product-row-unavailable">
                Edit, Archive and Permanently Delete need an assignment to every branch this product is set up for. Open View to create a branch copy
                for your own branch.
              </DropdownMenuLabel>
            ) : product.status !== 'archived' ? (
              <DropdownMenuItem onSelect={() => onAction('archive', product)}>Archive (off POS everywhere, restorable)…</DropdownMenuItem>
            ) : (
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Already archived. Restore it from its product page.</DropdownMenuLabel>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}
