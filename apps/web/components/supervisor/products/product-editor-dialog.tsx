'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogHost, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ProductStatusBadge } from '@/components/admin/products/product-status-badge';
import { ProductSizesPanel } from '@/components/products/product-sizes-panel';
import { RecipeBomPanel } from '@/components/products/recipe-bom-panel';
import { VariantChoicesCard } from '@/components/products/variant-choices-card';
import { useAuth } from '@/hooks/use-auth';
import { useProduct } from '@/hooks/queries/use-products';
import { canEditProductInPlace } from '@/lib/product-authority';
import { ProductDetailsForm } from './product-details-form';
import { ProductBranchRow } from './product-branch-row';

export const PRODUCT_EDITOR_TABS = ['details', 'sizes', 'ingredients', 'choices', 'branches'] as const;
export type ProductEditorTab = (typeof PRODUCT_EDITOR_TABS)[number];

const TAB_LABELS: Record<ProductEditorTab, string> = {
  details: 'Details',
  sizes: 'Sizes & Prices',
  ingredients: 'Ingredients & Packaging',
  choices: 'Flavors & Choices',
  branches: 'Branches',
};

interface ProductEditorDialogProps {
  productId: string;
  initialTab?: ProductEditorTab;
  onClose: () => void;
}

/**
 * POS-PERF-P39 — the Products page's Edit popup: one dialog, five tabs, the
 * existing editors and mutation hooks.
 *
 * Save semantics are spelled out in the dialog: Details is staged (Save
 * details / Discard changes, see ProductDetailsForm); every other tab's
 * actions persist the moment they're confirmed, exactly as in the builder and
 * on the product page, so the dialog has a Close button, never a Cancel that
 * would pretend to undo them. Closing with unsaved details, or with a size,
 * recipe or choice form still open, asks first.
 *
 * Those per-section forms open inside this dialog (DialogHost), as a panel
 * over the tab content — one modal, one focus trap, Escape backs out of the
 * panel first. The tabs are locked while a panel is open so it can't be
 * unmounted with its input.
 *
 * POS-PERF-P41 — each section form is an inline section of this dialog (see
 * DialogHost in ui/dialog.tsx) with a "Back to <tab>" button, and the
 * editor shows one scroll area at a time. Close, Back, Escape and Open
 * product page all ask before discarding unsaved details or a typed section
 * form; leaving the page warns too.
 */
export function ProductEditorDialog({ productId, initialTab = 'details', onClose }: ProductEditorDialogProps) {
  const { user } = useAuth();
  const { data: product, isLoading, isError, refetch } = useProduct(productId);
  const [tab, setTab] = useState<ProductEditorTab>(initialTab);
  const [detailsDirty, setDetailsDirty] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<null | 'close' | 'navigate'>(null);
  const router = useRouter();
  const [hostElement, setHostElement] = useState<HTMLDivElement | null>(null);
  const onDirtyChange = useCallback((dirty: boolean) => setDetailsDirty(dirty), []);
  const onPanelChange = useCallback((active: boolean) => setPanelOpen(active), []);

  const activeBranchIds = user?.branchIds ?? [];
  const canEdit =
    Boolean(product) &&
    product?.status !== 'archived' &&
    canEditProductInPlace(
      { branch_exclusive: product?.branch_exclusive ?? false, exclusive_branch_id: product?.exclusive_branch_id ?? null, configuredBranchIds: (product?.branch_availability ?? []).map((row) => row.branch_id) },
      activeBranchIds,
    );
  const variants = product ? [...product.variants].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0)) : [];
  const branches = product ? [...product.branch_availability].sort((a, b) => a.branch_name.localeCompare(b.branch_name)) : [];

  const hasUnsaved = detailsDirty || panelOpen;
  const productPageHref = `/supervisor/products/${productId}`;

  function requestClose() {
    if (hasUnsaved) {
      setConfirmDiscard('close');
      return;
    }
    onClose();
  }

  function discardAndContinue() {
    if (confirmDiscard === 'navigate') router.push(productPageHref);
    onClose();
  }

  // Reloading or leaving the site with typed, unsaved values asks first (the browser's own prompt).
  useEffect(() => {
    if (!hasUnsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsaved]);

  return (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent
        className="flex h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] w-[calc(100vw-1rem)] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:h-[min(52rem,calc(100dvh-2rem))] sm:w-[calc(100vw-2rem)]"
        // Escape while a section form is open is handled by that form (it closes first); with none open it is a close request.
        onEscapeKeyDown={(event) => {
          if (panelOpen) event.preventDefault();
        }}
        data-testid="product-editor"
        // The footer's Close is always visible; a second, identically named corner X would only duplicate it.
        showCloseButton={false}
      >
        <DialogHeader className="space-y-1 border-b px-4 py-3 text-left sm:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DialogTitle className="truncate">{product ? `Edit ${product.name}` : 'Edit product'}</DialogTitle>
            {product && <ProductStatusBadge status={product.status} />}
          </div>
          <DialogDescription>
            Details save with Save Changes. Sizes, ingredients, flavors, choices and branch changes each save as soon as you confirm them.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <LoadingSpinner size="lg" />
          </div>
        ) : isError || !product ? (
          <div className="flex-1 p-6">
            <ErrorState title="Couldn't load this product" retry={() => void refetch()} />
          </div>
        ) : (
          <Tabs value={tab} onValueChange={(value) => setTab(value as ProductEditorTab)} className="flex min-h-0 flex-1 flex-col">
            <div className="border-b px-2 sm:px-4">
              <TabsList aria-label="Product sections" className="h-auto w-full justify-start overflow-x-auto bg-transparent p-0">
                {PRODUCT_EDITOR_TABS.map((value) => (
                  <TabsTrigger key={value} value={value} disabled={panelOpen && value !== tab} className="shrink-0 py-2">
                    {TAB_LABELS[value]}
                    {value === 'details' && detailsDirty && <span className="ml-1 text-primary" aria-label="unsaved changes">•</span>}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            {!canEdit && (
              <div className="border-b bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200 sm:px-6">
                {product.status === 'archived'
                  ? 'This product is archived. Restore it from the product page to edit it.'
                  : "You can't edit this product here: it's set up for a branch outside your assignment."}{' '}
                <Link href={`/supervisor/products/${product.id}`} className="font-medium underline underline-offset-2">
                  Open product page
                </Link>
              </div>
            )}

            <div className="relative min-h-0 flex-1">
              <DialogHost container={hostElement} onActiveChange={onPanelChange} backLabel={`Back to ${TAB_LABELS[tab]}`}>
                {/* Hidden (and inert) while a section form is open, so only that form's scroll area is on screen. */}
                <div className={`h-full overflow-y-auto px-4 py-4 sm:px-6 ${panelOpen ? 'invisible' : ''}`} inert={panelOpen}>
                  {/* Details stays mounted while another tab is shown, so typed-but-unsaved values survive a tab switch. */}
                  <TabsContent value="details" forceMount className="mt-0 data-[state=inactive]:hidden">
                    <ProductDetailsForm product={product} disabled={!canEdit} onDirtyChange={onDirtyChange} />
                  </TabsContent>
                  <TabsContent value="sizes" className="mt-0 space-y-3">
                    <p className="text-xs text-muted-foreground">Adding, editing or deleting a size saves as soon as you confirm it; Close doesn&apos;t undo it.</p>
                    <ProductSizesPanel product={product} confirmDelete disabled={!canEdit} />
                  </TabsContent>
                  <TabsContent value="ingredients" className="mt-0 space-y-4">
                    <p className="text-xs text-muted-foreground">
                      What each size uses per serving. Each change saves as soon as you confirm it; every branch deducts its own stock.
                    </p>
                    {variants.length === 0 ? (
                      <EmptyState title="No sizes yet" description="Add a size first, then its ingredients and packaging." />
                    ) : (
                      variants.map((variant) => (
                        <RecipeBomPanel key={variant.id} productVariantId={variant.id} variantLabel={`${variant.name} (${variant.size_label})`} />
                      ))
                    )}
                  </TabsContent>
                  <TabsContent value="choices" className="mt-0 space-y-4">
                    <p className="text-xs text-muted-foreground">
                      Flavors, add-on option groups and Mix &amp; Max flavor slots per size. Each change saves as soon as you confirm it, and
                      Remove takes effect right away.
                    </p>
                    {variants.length === 0 ? (
                      <EmptyState title="No sizes yet" description="Add a size first, then its choices." />
                    ) : (
                      variants.map((variant) => <VariantChoicesCard key={variant.id} productId={product.id} variant={variant} />)
                    )}
                  </TabsContent>
                  <TabsContent value="branches" className="mt-0 space-y-3">
                    <p className="text-xs text-muted-foreground">
                      The branches this product is set up for. Publish here and Deactivate here take effect immediately, at that branch only;
                      nothing else changes.
                    </p>
                    {branches.length === 0 ? (
                      <EmptyState title="Not set up for any branch" description="Open the product page to manage where it is sold." />
                    ) : (
                      <ul className="space-y-2">
                        {branches.map((row) => (
                          <ProductBranchRow key={row.branch_id} product={product} row={row} assigned={activeBranchIds.includes(row.branch_id)} canEdit={canEdit} />
                        ))}
                      </ul>
                    )}
                  </TabsContent>
                </div>
                {/* Section forms (Add Size, recipe lines, flavors, slots, confirmations) render here, in place of the tab content. */}
                <div ref={setHostElement} className="pointer-events-none absolute inset-0" />
              </DialogHost>
            </div>
          </Tabs>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3 sm:px-6">
          {confirmDiscard ? (
            <div role="alert" className="flex w-full flex-wrap items-center justify-end gap-2">
              <span className="mr-auto text-sm">
                {panelOpen ? 'Close the form you have open and discard what you typed in it' : 'Discard your unsaved details'}
                {panelOpen && detailsDirty ? ', and your unsaved details?' : '?'}
              </span>
              <Button variant="outline" size="sm" onClick={() => setConfirmDiscard(null)} autoFocus>
                Keep editing
              </Button>
              <Button variant="danger" size="sm" onClick={discardAndContinue}>
                {confirmDiscard === 'navigate' ? 'Discard and open product page' : 'Discard and close'}
              </Button>
            </div>
          ) : (
            <>
              {product && (
                <Button variant="ghost" size="sm" asChild className="mr-auto">
                  <Link
                    href={productPageHref}
                    onClick={(event) => {
                      if (!hasUnsaved) return;
                      event.preventDefault();
                      setConfirmDiscard('navigate');
                    }}
                  >
                    Open product page
                  </Link>
                </Button>
              )}
              <Button variant="outline" onClick={requestClose}>
                Close
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
