import { ROLES, type ProductDeleteBlocker, type ProductDeletionPreview } from '@potato-corner/shared';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config/index.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { hasActiveCatalogAuthorityForProduct } from '../../lib/catalog-authority.js';
import { branchesRepository } from '../branches/branches.repository.js';
import { auditOutboxRepository } from '../audit-outbox/audit-outbox.repository.js';
import { PRODUCT_PERMANENTLY_DELETED_ACTION, productDeletionRepository, type ProductDeletionTarget } from './product-deletion.repository.js';
import { ProductError } from './products.types.js';

type ActorContext = { id: string; role: string };

const PRODUCT_IMAGE_BUCKET = 'product-images';

type Client = Parameters<typeof productDeletionRepository.findTarget>[1];

function listNames(names: string[]): string {
  const unique = [...new Set(names)];
  if (unique.length <= 1) return unique[0] ?? '';
  return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

/** Branches the product is set up for (availability rows) or exclusive to, by name. */
function involvedBranches(target: ProductDeletionTarget): { id: string; name: string; on_pos: boolean }[] {
  const byId = new Map<string, { id: string; name: string; on_pos: boolean }>();
  for (const row of target.branchAvailability) byId.set(row.branchId, { id: row.branchId, name: row.branch.name, on_pos: row.isAvailable });
  if (target.branchExclusive && target.exclusiveBranch && !byId.has(target.exclusiveBranch.id)) {
    byId.set(target.exclusiveBranch.id, { id: target.exclusiveBranch.id, name: target.exclusiveBranch.name, on_pos: false });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Complete branch scope: the existing catalog authority (every branch the
 * product is set up for, or its exclusive branch), plus every live branch it
 * was ever sold at. A deleted branch can't be anyone's assignment and its
 * history is kept either way, so it never blocks.
 */
async function authorityCheck(target: ProductDeletionTarget, saleBranchIds: string[], actor: ActorContext, client: Client) {
  if (actor.role !== ROLES.SUPERVISOR) {
    return { allowed: false, reason: 'Only a supervisor can permanently delete a product.' };
  }
  const active = new Set(await branchesRepository.findAllActiveBranchIds(actor.id));
  const configured = involvedBranches(target);
  const saleBranches = await productDeletionRepository.findLiveBranches(saleBranchIds, client);
  const outside = [...configured, ...saleBranches].filter((b) => !active.has(b.id)).map((b) => b.name);
  if (outside.length > 0 || !(await hasActiveCatalogAuthorityForProduct(target, actor.id))) {
    const named = outside.length > 0 ? `${listNames(outside)} ${new Set(outside).size === 1 ? 'is' : 'are'} outside your assignment` : 'a branch it is set up for is outside your assignment';
    return {
      allowed: false,
      reason: `This product is used at branches you don't manage: ${named}. Only a supervisor assigned to every branch involved can delete it permanently. To change it for your own branch, open it and use Create Branch Copy.`,
    };
  }
  return { allowed: true, reason: null };
}

async function findBlockers(target: ProductDeletionTarget, client: Client): Promise<ProductDeleteBlocker[]> {
  const variantIds = target.variants.map((v) => v.id);
  const [held, promotions, discountTypes, snackUsers, legacyLines] = await Promise.all([
    productDeletionRepository.findHeldOrders(target.id, client),
    productDeletionRepository.findPromotionNames(target.id, client),
    productDeletionRepository.findDiscountTypeNames(target.id, client),
    productDeletionRepository.findProductsUsingAsSnack(target.id, variantIds, client),
    productDeletionRepository.countLegacyReversibleLines(variantIds, client),
  ]);
  const blockers: ProductDeleteBlocker[] = [];
  if (held.length > 0) {
    const branches = [...new Set(held.map((h) => h.branch.name))];
    blockers.push({
      code: 'PRODUCT_DELETE_HELD_ORDERS',
      message: `${held.length} held order${held.length === 1 ? '' : 's'} at ${listNames(branches)} still contain${held.length === 1 ? 's' : ''} this product.`,
      next_action: 'Resume and complete, or cancel, those held orders on the POS first, then delete again.',
      names: branches,
    });
  }
  if (promotions.length > 0) {
    blockers.push({
      code: 'PRODUCT_DELETE_IN_PROMOTION',
      message: `It is part of ${promotions.length === 1 ? 'the promotion' : 'the promotions'} ${listNames(promotions)}.`,
      next_action: 'Remove it from those promotions under Promotions first, then delete again.',
      names: [...new Set(promotions)],
    });
  }
  if (discountTypes.length > 0) {
    blockers.push({
      code: 'PRODUCT_DELETE_IN_DISCOUNT_TYPE',
      message: `${discountTypes.length === 1 ? 'The discount type' : 'The discount types'} ${listNames(discountTypes)} ${discountTypes.length === 1 ? 'is' : 'are'} limited to this product.`,
      next_action: 'Remove it from those discount types under Discounts first, then delete again.',
      names: [...new Set(discountTypes)],
    });
  }
  if (snackUsers.length > 0) {
    blockers.push({
      code: 'PRODUCT_DELETE_USED_AS_SNACK_OPTION',
      message: `It is offered as a snack choice inside ${listNames(snackUsers)}.`,
      next_action: 'Remove it from those products’ Mix & Max choices first, then delete again.',
      names: [...new Set(snackUsers)],
    });
  }
  if (legacyLines > 0) {
    blockers.push({
      code: 'PRODUCT_DELETE_LEGACY_SALES',
      message: `${legacyLines} completed sale line${legacyLines === 1 ? ' was' : 's were'} recorded before stock snapshots existed. Voiding or refunding ${legacyLines === 1 ? 'it' : 'them'} uses this product’s recipe.`,
      next_action: 'Deactivate or archive this product instead. It can be deleted once those older sales no longer need its recipe.',
      names: [],
    });
  }
  return blockers;
}

function auditSnapshot(target: ProductDeletionTarget, saleCount: number) {
  return {
    id: target.id,
    name: target.name,
    description: target.description,
    status: target.status,
    classification: target.classification,
    category: target.category,
    category_id: target.categoryId,
    product_type_id: target.productTypeId,
    branch_exclusive: target.branchExclusive,
    exclusive_branch: target.exclusiveBranch,
    forked_from_product_id: target.forkedFromProductId,
    created_by: target.createdBy,
    managed_by: target.managedBy,
    created_at: target.createdAt.toISOString(),
    had_image: target.imagePath !== null,
    branches: involvedBranches(target),
    sizes: target.variants.map((v) => ({
      id: v.id,
      name: v.name,
      size_label: v.sizeLabel,
      base_price: v.basePrice.toString(),
      is_active: v.isActive,
      lifecycle_status: v.lifecycleStatus,
    })),
    sale_count: saleCount,
    branch_copy_count: target._count.forkedCopies,
  };
}

/**
 * Rollout switch (PRODUCT_PERMANENT_DELETE_ENABLED, off by default). An API
 * version from before this release mishandles a sale of a permanently deleted
 * product (500 and a stuck checkout attempt in a race; a retryable code for
 * offline sales), so nothing is deleted until every instance runs this one.
 */
const DISABLED_REASON =
  'Permanent delete is not switched on yet for this system. Deactivate or archive the product for now.';
function assertEnabled(): void {
  if (!config.productPermanentDeleteEnabled) {
    throw new ProductError('PRODUCT_PERMANENT_DELETE_DISABLED', DISABLED_REASON, 409);
  }
}

async function notFound(productId: string): Promise<never> {
  if (await productDeletionRepository.wasPermanentlyDeleted(productId)) {
    throw new ProductError('PRODUCT_ALREADY_DELETED', 'This product was already permanently deleted. Its sales history is kept.', 410);
  }
  throw new ProductError('PRODUCT_NOT_FOUND', 'Product not found', 404);
}

export const productDeletionService = {
  /** What a permanent delete would remove, keep and need first. Read-only. */
  async getPreview(productId: string, actor: ActorContext): Promise<ProductDeletionPreview> {
    const target = await productDeletionRepository.findTarget(productId);
    if (!target) return notFound(productId);
    const { saleCount, branchIds } = await productDeletionRepository.saleSummary(target.variants.map((v) => v.id));
    const authority = config.productPermanentDeleteEnabled
      ? await authorityCheck(target, branchIds, actor, prisma)
      : { allowed: false, reason: DISABLED_REASON };
    return {
      product: { id: target.id, name: target.name },
      branches: involvedBranches(target),
      size_count: target.variants.length,
      sale_count: saleCount,
      branch_copy_count: target._count.forkedCopies,
      is_branch_copy: target.forkedFromProductId !== null,
      has_image: target.imagePath !== null,
      can_delete: authority.allowed,
      forbidden_reason: authority.reason,
      // Blockers are only described to someone who may act on them.
      blockers: authority.allowed ? await findBlockers(target, prisma) : [],
    };
  },

  /**
   * Physically removes the product, its sizes and its own setup in one
   * transaction, under the product's catalog lock and a row lock, with the
   * audit entry enqueued in the same transaction. History is not touched:
   * every sale, refund, receipt, held-order line, change log, stock movement
   * and audit entry keeps its own product id and snapshots. A retry after
   * success gets 410 PRODUCT_ALREADY_DELETED (nothing changes).
   */
  async permanentlyDelete(productId: string, actor: ActorContext, ipAddress: string | null): Promise<{ id: string; name: string }> {
    assertEnabled();
    const result = await prisma.$transaction(
      async (tx) => {
        await productDeletionRepository.lockForDelete(tx, productId);
        const target = await productDeletionRepository.findTarget(productId, tx);
        if (!target) return null;

        const variantIds = target.variants.map((v) => v.id);
        const { saleCount, branchIds } = await productDeletionRepository.saleSummary(variantIds, tx);
        const authority = await authorityCheck(target, branchIds, actor, tx);
        if (!authority.allowed) throw new ProductError('PRODUCT_DELETE_FORBIDDEN', authority.reason ?? 'Not allowed', 403);

        const blockers = await findBlockers(target, tx);
        if (blockers.length > 0) {
          throw new ProductError(
            'PRODUCT_DELETE_BLOCKED',
            `${target.name} can't be deleted yet. ${blockers.map((b) => b.message).join(' ')}`,
            409,
            { blockers },
          );
        }

        await productDeletionRepository.deleteProductAndOwnSetup(tx, productId, variantIds);
        await auditOutboxRepository.enqueue(tx, [
          {
            action: PRODUCT_PERMANENTLY_DELETED_ACTION,
            entityType: 'product',
            entityId: productId,
            actorId: actor.id,
            actorRole: actor.role,
            branchId: target.exclusiveBranchId,
            beforeState: auditSnapshot(target, saleCount),
            afterState: { deleted: true, history_kept: true },
            ipAddress,
          },
        ]);
        return { id: target.id, name: target.name, imagePath: target.imagePath };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    if (!result) return notFound(productId);

    // The image object is the product's own; removing it after commit is best
    // effort (a leftover object is unreachable: nothing names its key any more).
    if (result.imagePath) {
      try {
        const { error } = await supabaseAdmin.storage.from(PRODUCT_IMAGE_BUCKET).remove([result.imagePath]);
        if (error) console.warn('Product image cleanup after permanent delete failed', { productId });
      } catch {
        console.warn('Product image cleanup after permanent delete failed', { productId });
      }
    }
    return { id: result.id, name: result.name };
  },
};
