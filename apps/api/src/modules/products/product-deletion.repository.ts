import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { productCatalogLockId } from '../../lib/pg-lock.js';

type Client = Prisma.TransactionClient | typeof prisma;

export const PRODUCT_PERMANENTLY_DELETED_ACTION = 'PRODUCT_PERMANENTLY_DELETED';

const targetSelect = {
  id: true,
  name: true,
  description: true,
  status: true,
  classification: true,
  category: true,
  categoryId: true,
  productTypeId: true,
  branchExclusive: true,
  exclusiveBranchId: true,
  forkedFromProductId: true,
  imagePath: true,
  createdBy: true,
  managedBy: true,
  createdAt: true,
  exclusiveBranch: { select: { id: true, name: true } },
  branchAvailability: { select: { branchId: true, isAvailable: true, branch: { select: { name: true } } } },
  variants: { select: { id: true, name: true, sizeLabel: true, basePrice: true, isActive: true, lifecycleStatus: true } },
  _count: { select: { forkedCopies: true } },
} satisfies Prisma.ProductSelect;

export type ProductDeletionTarget = Prisma.ProductGetPayload<{ select: typeof targetSelect }>;

/**
 * Product permanent delete — persistence for the delete preview and the
 * delete itself. Everything the delete changes is the product's own
 * operational setup; history (sales, refunds, held-order lines, change logs,
 * stock movements, audit) is only ever read here, never written.
 */
export const productDeletionRepository = {
  findTarget(productId: string, client: Client = prisma): Promise<ProductDeletionTarget | null> {
    return client.product.findUnique({ where: { id: productId }, select: targetSelect });
  },

  /**
   * Serializes with every other catalog write for this product (the same
   * advisory key publish/edit/type-scope use), then row-locks the product.
   * A sale or hold line insert locks that row FOR KEY SHARE (live-product
   * trigger), so it either committed before this lock (and is history the
   * checks below see) or waits and then fails with PRODUCT_DELETED.
   */
  async lockForDelete(tx: Prisma.TransactionClient, productId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${productCatalogLockId(productId)})`;
    await tx.$queryRaw`SELECT "id" FROM "products" WHERE "id" = ${productId} FOR UPDATE`;
  },

  /** Sales containing any size of the product, and the branches they were rung at. */
  async saleSummary(variantIds: string[], client: Client = prisma): Promise<{ saleCount: number; branchIds: string[] }> {
    if (variantIds.length === 0) return { saleCount: 0, branchIds: [] };
    const where: Prisma.TransactionWhereInput = { items: { some: { productVariantId: { in: variantIds } } } };
    const [saleCount, branches] = await Promise.all([
      client.transaction.count({ where }),
      client.transaction.findMany({ where, select: { branchId: true }, distinct: ['branchId'] }),
    ]);
    return { saleCount, branchIds: branches.map((b) => b.branchId) };
  },

  /** Live branches among `branchIds`, with names (a deleted branch has no live row). */
  findLiveBranches(branchIds: string[], client: Client = prisma) {
    if (branchIds.length === 0) return Promise.resolve([] as { id: string; name: string }[]);
    return client.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } });
  },

  /** Held (unresolved) orders containing the product, with their branch names. */
  findHeldOrders(productId: string, client: Client = prisma) {
    return client.holdOrder.findMany({
      where: { status: 'held', items: { some: { productId } } },
      select: { id: true, branch: { select: { name: true } } },
    });
  },

  findPromotionNames(productId: string, client: Client = prisma) {
    return client.promotionProduct
      .findMany({ where: { productId }, select: { promotion: { select: { name: true } } } })
      .then((rows) => rows.map((r) => r.promotion.name));
  },

  findDiscountTypeNames(productId: string, client: Client = prisma) {
    return client.manualDiscountTypeProduct
      .findMany({ where: { productId }, select: { manualDiscountType: { select: { name: true } } } })
      .then((rows) => rows.map((r) => r.manualDiscountType.name));
  },

  /** Other products whose Mix & Max slots offer one of this product's sizes as a snack. */
  findProductsUsingAsSnack(productId: string, variantIds: string[], client: Client = prisma) {
    if (variantIds.length === 0) return Promise.resolve([] as string[]);
    return client.productFlavorSlotSnackOption
      .findMany({
        where: { snackProductVariantId: { in: variantIds }, flavorSlot: { productVariant: { productId: { not: productId } } } },
        select: { flavorSlot: { select: { productVariant: { select: { product: { select: { name: true } } } } } } },
      })
      .then((rows) => rows.map((r) => r.flavorSlot.productVariant.product.name));
  },

  /**
   * Completed sale lines recorded before deduction snapshots existed. A void
   * or refund of such a sale recomputes the stock to return from the live
   * recipe, so deleting the recipe would change what that reversal returns.
   */
  countLegacyReversibleLines(variantIds: string[], client: Client = prisma): Promise<number> {
    if (variantIds.length === 0) return Promise.resolve(0);
    return client.transactionItem.count({
      where: { productVariantId: { in: variantIds }, deductionSnapshot: { equals: Prisma.DbNull }, transaction: { status: 'completed' } },
    });
  },

  /**
   * Removes only rows that exist for this product alone: its branch
   * availability, and each of its sizes' flavor links, option-group
   * assignments, recipe components, legacy ingredient links and flavor slots
   * (with their snack options). Shared inventory items, flavors, options,
   * option groups, categories, types and other products are never touched.
   * Branch copies made from it keep working; their "copied from" link is
   * cleared by the existing ON DELETE SET NULL.
   */
  async deleteProductAndOwnSetup(tx: Prisma.TransactionClient, productId: string, variantIds: string[]): Promise<void> {
    // The history guard (migration 20261124130000) refuses deleting a product or
    // size that history still names, for every path but this one. Called only
    // after the authority and blocker checks, under the product's locks; the
    // setting is transaction-local and ends with this transaction.
    await tx.$queryRaw`SELECT set_config('pc.product_permanent_delete', 'on', true)`;
    await tx.branchProductAvailability.deleteMany({ where: { productId } });
    if (variantIds.length > 0) {
      const inVariants = { in: variantIds };
      await tx.productVariantFlavor.deleteMany({ where: { productVariantId: inVariants } });
      await tx.productVariantOptionGroup.deleteMany({ where: { productVariantId: inVariants } });
      await tx.productComponent.deleteMany({ where: { productVariantId: inVariants } });
      await tx.productInventory.deleteMany({ where: { productVariantId: inVariants } });
      await tx.productFlavorSlotSnackOption.deleteMany({ where: { flavorSlot: { productVariantId: inVariants } } });
      await tx.productFlavorSlot.deleteMany({ where: { productVariantId: inVariants } });
      await tx.productVariant.deleteMany({ where: { productId } });
    }
    await tx.product.delete({ where: { id: productId } });
  },

  /** True when this product id was permanently deleted before (delivered or still in the audit outbox). */
  async wasPermanentlyDeleted(productId: string): Promise<boolean> {
    const where = { action: PRODUCT_PERMANENTLY_DELETED_ACTION, entityId: productId };
    const [logged, queued] = await Promise.all([
      prisma.auditLog.findFirst({ where, select: { id: true } }),
      prisma.auditOutbox.findFirst({ where, select: { id: true } }),
    ]);
    return Boolean(logged || queued);
  },
};
