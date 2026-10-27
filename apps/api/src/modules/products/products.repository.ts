import type { Prisma, ProductStatus as PrismaProductStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { ProductBranchView } from '@potato-corner/shared';
import type {
  CreateProductData,
  CreateVariantData,
  InsertVariantChangeLogData,
  ProductListFilters,
  UpdateProductData,
  UpdateVariantData,
  UpdateVariantLifecycleData,
} from './products.types.js';

const creatorInclude = {
  creator: { select: { id: true, firstName: true, lastName: true, email: true } },
  exclusiveBranch: { select: { id: true, name: true } },
  productCategory: { select: { id: true, name: true } },
} satisfies Prisma.ProductInclude;

const publicationItemSelect = {
  select: { id: true, name: true, deletedAt: true, baseUnitId: true, baseUnit: { select: { code: true } } },
} satisfies Prisma.InventoryItemDefaultArgs;

const publicationOptionSelect = {
  id: true,
  name: true,
  isActive: true,
  inventoryMapping: {
    select: { deductionUnitId: true, deductionUnit: { select: { code: true } }, inventoryItem: publicationItemSelect },
  },
} satisfies Prisma.ProductOptionSelect;

const detailInclude = {
  ...creatorInclude,
  variants: {
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }] as Prisma.ProductVariantOrderByWithRelationInput[],
    include: {
      variantFlavors: {
        include: { flavor: { select: { id: true, name: true, colorHex: true } } },
      },
    },
  },
  branchAvailability: {
    include: { branch: { select: { id: true, code: true, name: true, city: true } } },
  },
} satisfies Prisma.ProductInclude;

function buildWhere(filters: Pick<ProductListFilters, 'status' | 'category' | 'search' | 'is_seasonal'>): Prisma.ProductWhereInput {
  return {
    ...(filters.status && { status: filters.status }),
    ...(filters.category && { category: { equals: filters.category, mode: 'insensitive' } }),
    ...(filters.is_seasonal !== undefined && { isSeasonal: filters.is_seasonal }),
    ...(filters.search && {
      OR: [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { category: { contains: filters.search, mode: 'insensitive' } },
      ],
    }),
  };
}

/** POS-PERF-P39 — product-level audit actions that mean it has been managed on POS before (so it is no longer a draft). */
const PRODUCT_PUBLICATION_HISTORY_ACTIONS = [
  'PRODUCT_STATUS_CHANGED',
  'PRODUCT_CATALOG_REMOVAL_CASCADE',
  'PRODUCT_CATALOG_RESTORE_CASCADE',
  'PRODUCT_REPLACED_AT_BRANCH',
];

/** POS-PERF-P39 — the tab a product configured at this branch belongs to; see productListResponseSchema's PRODUCT_BRANCH_VIEWS. */
function branchViewOf(product: BranchScopedProduct, branchId: string, draftIds: Set<string>): ProductBranchView {
  if (draftIds.has(product.id)) return 'drafts';
  const onPosHere = product.status === 'active' && product.branchAvailability.some((row) => row.branchId === branchId && row.isAvailable);
  return onPosHere ? 'active' : 'inactive';
}

type BranchScopedProduct = {
  id: string;
  status: PrismaProductStatus;
  branchAvailability: { id: string; branchId: string; isAvailable: boolean }[];
};

const SORT_FIELD_MAP: Record<NonNullable<ProductListFilters['sort_by']>, string> = {
  name: 'name',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  display_order: 'displayOrder',
  status: 'status',
};

/**
 * Products repository. All Prisma calls for this module live here — the
 * router and service layers never call Prisma directly.
 */
export const productsRepository = {
  async findAll(filters: ProductListFilters) {
    const base = buildWhere(filters);
    const sortField = SORT_FIELD_MAP[filters.sort_by ?? 'created_at'];
    const sortOrder = filters.sort_order ?? 'desc';

    // POS-PERF-P39 — a branch-scoped request (the supervisor Products tabs)
    // reads the small set of products configured at the branch once,
    // classifies them in memory (so the three counts and the listed tab
    // always agree), then loads only the requested page. A handful of
    // sequential queries rather than one per count, so it never holds
    // several pool connections at once.
    let where: Prisma.ProductWhereInput = base;
    let counts: Record<ProductBranchView, number> | undefined;
    if (filters.branch_id) {
      const branchId = filters.branch_id;
      const scoped = await prisma.product.findMany({
        where: { AND: [base, { branchAvailability: { some: { branchId } } }] },
        select: { id: true, status: true, branchAvailability: { select: { id: true, branchId: true, isAvailable: true } } },
      });
      const draftIds = await productsRepository.findDraftIds(scoped);
      const idsByView: Record<ProductBranchView, string[]> = { active: [], drafts: [], inactive: [] };
      for (const product of scoped) idsByView[branchViewOf(product, branchId, draftIds)].push(product.id);
      counts = { active: idsByView.active.length, drafts: idsByView.drafts.length, inactive: idsByView.inactive.length };
      where = { id: { in: filters.view ? idsByView[filters.view] : scoped.map((product) => product.id) } };
    }

    const products = await prisma.product.findMany({
      where,
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
      // id breaks ties so a page boundary never repeats or skips a row.
      orderBy: [{ [sortField]: sortOrder }, { id: 'asc' }],
      include: {
        _count: { select: { variants: true } },
        variants: { select: { isActive: true } },
        branchAvailability: { select: { isAvailable: true, branchId: true, branch: { select: { name: true } } } },
        exclusiveBranch: { select: { id: true, name: true } },
        productCategory: { select: { id: true, name: true } },
      },
    });
    const total = counts && filters.view ? counts[filters.view] : await prisma.product.count({ where });

    return { products, total, counts };
  },

  /**
   * POS-PERF-P39 — which of these products are still drafts. There is no
   * "ever published" column: the builder creates products with status
   * 'active' and leaves every branch row off until Add to POS, so a builder
   * draft and a product later taken off POS everywhere look the same on the
   * product row. The difference is history: every availability change
   * (publish, unpublish, temporarily unavailable) is audited against the
   * availability row, and a global lifecycle change against the product. So
   * a draft is a status 'draft' product, or a status 'active' product that
   * is on POS nowhere and has no such audit entry — delivered or still
   * queued in the audit outbox. `products` must carry every one of their
   * availability rows (all branches), not just the selected branch's.
   */
  async findDraftIds(products: BranchScopedProduct[]): Promise<Set<string>> {
    const neverOnPos = products.filter((product) => product.status === 'active' && !product.branchAvailability.some((row) => row.isAvailable));
    const drafts = new Set(products.filter((product) => product.status === 'draft').map((product) => product.id));
    if (neverOnPos.length === 0) return drafts;

    const rowIds = neverOnPos.flatMap((product) => product.branchAvailability.map((row) => row.id));
    const productIds = neverOnPos.map((product) => product.id);
    const historyWhere = {
      OR: [
        { entityType: 'branch_product_availability', entityId: { in: rowIds } },
        { entityType: 'product', entityId: { in: productIds }, action: { in: PRODUCT_PUBLICATION_HISTORY_ACTIONS } },
      ],
    };
    const logged = await prisma.auditLog.findMany({ where: historyWhere, select: { entityId: true }, distinct: ['entityId'] });
    const queued = await prisma.auditOutbox.findMany({ where: historyWhere, select: { entityId: true }, distinct: ['entityId'] });
    const withHistory = new Set([...logged, ...queued].map((entry) => entry.entityId));
    for (const product of neverOnPos) {
      if (!withHistory.has(product.id) && !product.branchAvailability.some((row) => withHistory.has(row.id))) drafts.add(product.id);
    }
    return drafts;
  },

  async findById(productId: string) {
    const result = await prisma.product.findUnique({ where: { id: productId }, include: detailInclude });
    return result;
  },

  /** Lightweight variant list for productReadinessService's product-level aggregation — avoids detailInclude's flavor/branch joins the readiness engine already fetches itself. */
  findVariantsForReadiness(productId: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
    return client.productVariant.findMany({
      where: { productId },
      select: { id: true, name: true, isActive: true, lifecycleStatus: true },
    });
  },

  findByName(name: string) {
    return prisma.product.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
  },

  /**
   * CR-001: product creation and its branch_product_availability cascade run
   * in one transaction — a crash partway through must never leave a product
   * with no availability rows (invisible everywhere) or a half-cascaded set.
   * branch_exclusive true seeds only exclusiveBranchId; false seeds every
   * currently-active branch.
   */
  async createWithCascade(data: CreateProductData, createdBy: string) {
    return prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          name: data.name,
          description: data.description,
          category: data.category,
          categoryId: data.categoryId,
          status: data.status,
          displayOrder: data.displayOrder,
          isSeasonal: data.isSeasonal,
          seasonalStartDate: data.seasonalStartDate ? new Date(data.seasonalStartDate) : undefined,
          seasonalEndDate: data.seasonalEndDate ? new Date(data.seasonalEndDate) : undefined,
          branchExclusive: data.branchExclusive,
          exclusiveBranchId: data.branchExclusive ? data.exclusiveBranchId : undefined,
          branchSelectionScoped: !data.branchExclusive && data.selectedBranchIds !== undefined,
          createdBy,
        },
      });

      // POS-PERF-P34R — rows are seeded unavailable (isAvailable: false):
      // "a branch_product_availability row exists" must never mean "this
      // product is published and sellable there." Publishing is a distinct,
      // readiness-gated action (productsService.publishProduct /
      // updateBranchProductAvailability) performed after setup — never an
      // automatic side effect of creation. This matches publishProduct's own
      // assumption that BRANCH_NOT_AVAILABLE is the normal pre-publish state.
      let cascadedBranchIds: string[];
      if (data.branchExclusive && data.exclusiveBranchId) {
        cascadedBranchIds = [data.exclusiveBranchId];
        await tx.branchProductAvailability.create({
          data: { branchId: data.exclusiveBranchId, productId: product.id, isAvailable: false, updatedBy: createdBy },
        });
      } else if (data.selectedBranchIds !== undefined) {
        // POS-PERF-P37 — multi-branch selection: rows only at the selected
        // branches, never the company-wide cascade below. The caller
        // (productsService.createProduct) has already deduplicated the ids
        // and verified each one is active and assigned to the actor.
        cascadedBranchIds = data.selectedBranchIds;
        await tx.branchProductAvailability.createMany({
          data: data.selectedBranchIds.map((branchId) => ({ branchId, productId: product.id, isAvailable: false, updatedBy: createdBy })),
        });
      } else {
        const activeBranches = await tx.branch.findMany({ where: { status: 'active' }, select: { id: true } });
        cascadedBranchIds = activeBranches.map((b) => b.id);
        if (activeBranches.length > 0) {
          await tx.branchProductAvailability.createMany({
            data: activeBranches.map((b) => ({ branchId: b.id, productId: product.id, isAvailable: false, updatedBy: createdBy })),
          });
        }
      }

      const withDetail = await tx.product.findUniqueOrThrow({ where: { id: product.id }, include: detailInclude });
      return { product: withDetail, cascadedBranchIds };
    });
  },

  /** POS-PERF-P36R4 — idempotency read for forkProductCascade: a fork already made for this (source product, destination branch) pair, if any. */
  findForkCopy(sourceProductId: string, branchId: string) {
    return prisma.product.findUnique({
      where: { forkedFromProductId_exclusiveBranchId: { forkedFromProductId: sourceProductId, exclusiveBranchId: branchId } },
      include: detailInclude,
    });
  },

  /**
   * POS-PERF-P36R4 — scoped copy/fork path: a supervisor who controls only
   * some of a shared product's branches cannot edit its global rows
   * (Product/ProductVariant/ProductComponent/ProductFlavorSlot/
   * ProductVariantOptionGroup — see catalog-authority.ts) in place, since
   * that would change every branch selling it, not just theirs. This clones
   * the product's full configuration into a brand-new, branch-exclusive
   * Product the acting supervisor fully owns, so they can keep configuring
   * their own branch's version independently.
   *
   * Deliberately NOT copied: InventoryStock/InventoryStockMovement balances,
   * TransactionItem/HoldOrderItem sale history, pending inventory-deduction
   * jobs, and ProductChangeLog audit history — none of that is "catalog
   * configuration," and copying it would fabricate history or double-count
   * stock. The source product, its id, its variants' ids, and its own sale
   * history are completely untouched.
   *
   * Idempotency: the unique index on (forkedFromProductId, exclusiveBranchId)
   * makes a concurrent/retried fork for the same pair resolve to one row —
   * the transaction below can race with another request also forking this
   * exact (productId, branchId) pair, hit a P2002 unique-violation on the
   * final create, and the caller (products.service.ts's forkProductForBranch)
   * falls back to findForkCopy to return the winner's row rather than erroring.
   */
  async forkProductCascade(sourceProductId: string, branchId: string, actorId: string) {
    const source = await prisma.product.findUnique({
      where: { id: sourceProductId },
      include: {
        variants: {
          include: {
            variantFlavors: true,
            productComponents: { where: { deletedAt: null } },
            optionGroupAssignments: { include: { allowedOptions: true } },
            flavorSlots: { include: { snackOptions: true } },
          },
        },
      },
    });
    if (!source) return null;

    return prisma.$transaction(async (tx) => {
      const forked = await tx.product.create({
        data: {
          name: source.name,
          description: source.description,
          category: source.category,
          categoryId: source.categoryId,
          status: 'draft',
          displayOrder: source.displayOrder,
          isSeasonal: source.isSeasonal,
          seasonalStartDate: source.seasonalStartDate,
          seasonalEndDate: source.seasonalEndDate,
          branchExclusive: true,
          exclusiveBranchId: branchId,
          forkedFromProductId: sourceProductId,
          createdBy: actorId,
        },
      });

      await tx.branchProductAvailability.create({
        data: { branchId, productId: forked.id, isAvailable: false, updatedBy: actorId },
      });

      for (const variant of source.variants) {
        const newVariant = await tx.productVariant.create({
          data: {
            productId: forked.id,
            name: variant.name,
            sizeLabel: variant.sizeLabel,
            basePrice: variant.basePrice,
            vatableCapAmount: variant.vatableCapAmount,
            displayOrder: variant.displayOrder,
            isActive: variant.isActive,
            kcal: variant.kcal,
            maxFlavors: variant.maxFlavors,
            lifecycleStatus: 'ACTIVE',
            createdById: actorId,
          },
        });

        if (variant.variantFlavors.length > 0) {
          await tx.productVariantFlavor.createMany({
            data: variant.variantFlavors.map((vf) => ({
              productVariantId: newVariant.id,
              flavorId: vf.flavorId,
              pricePremium: vf.pricePremium,
              isAvailable: vf.isAvailable,
            })),
          });
        }

        if (variant.productComponents.length > 0) {
          await tx.productComponent.createMany({
            data: variant.productComponents.map((c) => ({
              productVariantId: newVariant.id,
              inventoryItemId: c.inventoryItemId,
              quantityRequired: c.quantityRequired,
              recipeUnitId: c.recipeUnitId,
              flavorId: c.flavorId,
              productOptionId: c.productOptionId,
              createdBy: actorId,
            })),
          });
        }

        for (const group of variant.optionGroupAssignments) {
          const newAssignment = await tx.productVariantOptionGroup.create({
            data: {
              productVariantId: newVariant.id,
              optionGroupId: group.optionGroupId,
              required: group.required,
              sortOrder: group.sortOrder,
              createdBy: actorId,
            },
          });
          if (group.allowedOptions.length > 0) {
            await tx.productVariantOptionGroupOption.createMany({
              data: group.allowedOptions.map((o) => ({
                variantOptionGroupId: newAssignment.id,
                productOptionId: o.productOptionId,
                sortOrder: o.sortOrder,
              })),
            });
          }
        }

        for (const slot of variant.flavorSlots) {
          const newSlot = await tx.productFlavorSlot.create({
            data: {
              productVariantId: newVariant.id,
              slotIndex: slot.slotIndex,
              label: slot.label,
              flavorQty: slot.flavorQty,
              unit: slot.unit,
              required: slot.required,
            },
          });
          if (slot.snackOptions.length > 0) {
            await tx.productFlavorSlotSnackOption.createMany({
              data: slot.snackOptions.map((so) => ({
                flavorSlotId: newSlot.id,
                // The snack option still points at the ORIGINAL snack
                // ProductVariant (e.g. Fries, Loopys) — those are their own
                // independent products with their own branch authority and
                // are not part of what this fork is cloning.
                snackProductVariantId: so.snackProductVariantId,
              })),
            });
          }
        }
      }

      return tx.product.findUniqueOrThrow({ where: { id: forked.id }, include: detailInclude });
    });
  },

  /**
   * POS-PERF-P36R2 — must stay a single conditional statement. The previous
   * shape (service reads `before.version`, checks it, then this method does
   * a plain `update({ where: { id } })` with no version predicate) leaves a
   * race window: two requests that both read the same version can both pass
   * the service's check and both write, because nothing here enforces
   * mutual exclusion. Folding the version predicate into the WHERE clause of
   * one `updateMany` makes the compare-and-swap atomic at the database
   * level — only one concurrent caller can match `version: expectedVersion`
   * and its own write is what invalidates the other's.  Returns the updated
   * row's id, or null if the predicate matched zero rows (stale version).
   */
  async update(productId: string, data: UpdateProductData, expectedVersion?: number) {
    const { count } = await prisma.product.updateMany({
      where: { id: productId, ...(expectedVersion !== undefined && { version: expectedVersion }) },
      data: {
        name: data.name,
        description: data.description,
        category: data.category,
        ...(data.categoryId !== undefined && { categoryId: data.categoryId }),
        displayOrder: data.displayOrder,
        isSeasonal: data.isSeasonal,
        ...(data.seasonalStartDate !== undefined && {
          seasonalStartDate: data.seasonalStartDate ? new Date(data.seasonalStartDate) : null,
        }),
        ...(data.seasonalEndDate !== undefined && {
          seasonalEndDate: data.seasonalEndDate ? new Date(data.seasonalEndDate) : null,
        }),
        version: { increment: 1 },
      },
    });
    if (count === 0) return null;
    return prisma.product.findUniqueOrThrow({ where: { id: productId }, include: detailInclude });
  },

  updateStatus(productId: string, status: PrismaProductStatus) {
    return prisma.product.update({
      where: { id: productId },
      data: { status },
      include: detailInclude,
    });
  },

  countActiveBranches(productId: string) {
    return prisma.branchProductAvailability.count({ where: { productId, isAvailable: true } });
  },

  createVariant(productId: string, data: CreateVariantData) {
    return prisma.productVariant.create({
      data: {
        productId,
        name: data.name,
        sizeLabel: data.sizeLabel,
        basePrice: data.basePrice,
        displayOrder: data.displayOrder,
        isActive: data.isActive,
        lifecycleStatus: data.lifecycleStatus,
        createdById: data.createdById,
      },
    });
  },

  /**
   * POS-PERF-P36R2 — this path previously never touched `version` at all
   * (it only moved for the separate flavor-slot governance path), so the
   * expected_version check in products.service.ts's updateVariant could
   * never actually detect a stale edit: the DB value it compared against
   * never changed. Same atomic-compare-and-swap shape as products.update
   * above: fold the predicate into the WHERE clause and increment version
   * on every successful write. Returns null if the predicate matched zero
   * rows (stale version).
   */
  async updateVariant(variantId: string, data: UpdateVariantData, expectedVersion?: number) {
    const { count } = await prisma.productVariant.updateMany({
      where: { id: variantId, ...(expectedVersion !== undefined && { version: expectedVersion }) },
      data: {
        name: data.name,
        sizeLabel: data.sizeLabel,
        basePrice: data.basePrice,
        displayOrder: data.displayOrder,
        isActive: data.isActive,
        version: { increment: 1 },
      },
    });
    if (count === 0) return null;
    return prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
  },

  findVariantById(variantId: string) {
    return prisma.productVariant.findUnique({
      where: { id: variantId },
      include: {
        // POS-PERF-P36 — branchAvailability is needed by
        // hasActiveCatalogAuthorityForProduct's sellingBranchIds derivation;
        // see catalog-authority.ts.
        product: { include: { branchAvailability: { select: { branchId: true, isAvailable: true } } } },
        variantFlavors: { include: { flavor: { select: { id: true, name: true, colorHex: true } } } },
      },
    });
  },

  /** Deletes the variant's own flavor links first (config, not history), then the variant — one transaction so a P2003 on the variant leaves the links intact. */
  deleteVariantCascade(variantId: string) {
    return prisma.$transaction(async (tx) => {
      await tx.productVariantFlavor.deleteMany({ where: { productVariantId: variantId } });
      return tx.productVariant.delete({ where: { id: variantId } });
    });
  },

  /** Deletes the product's own config rows (branch availability, each variant's flavor links) then its variants then the product — one transaction so a P2003 anywhere rolls the whole thing back. */
  deleteProductCascade(productId: string, variantIds: string[]) {
    return prisma.$transaction(async (tx) => {
      await tx.branchProductAvailability.deleteMany({ where: { productId } });
      for (const variantId of variantIds) {
        await tx.productVariantFlavor.deleteMany({ where: { productVariantId: variantId } });
        await tx.productVariant.delete({ where: { id: variantId } });
      }
      return tx.product.delete({ where: { id: productId } });
    });
  },

  async upsertBranchProductAvailability(
    branchId: string,
    productId: string,
    isAvailable: boolean,
    updatedBy: string,
    tx: Prisma.TransactionClient | typeof prisma = prisma,
  ) {
    return tx.branchProductAvailability.upsert({
      where: { branchId_productId: { branchId, productId } },
      create: { branchId, productId, isAvailable, updatedBy },
      update: { isAvailable, updatedBy },
      include: { branch: { select: { id: true, code: true, name: true, city: true } } },
    });
  },

  findBranchProductAvailability(productId: string) {
    return prisma.branchProductAvailability.findMany({
      where: { productId },
      include: { branch: { select: { id: true, code: true, name: true, city: true } } },
    });
  },

  /** Sets every branch_product_availability row for this product to unavailable — used when a product goes discontinued or archived globally. */
  cascadeBranchAvailabilityOff(productId: string, updatedBy: string) {
    return prisma.branchProductAvailability.updateMany({
      where: { productId, isAvailable: true },
      data: { isAvailable: false, updatedBy },
    });
  },

  /**
   * Sets branch_product_availability back to available (at active branches
   * only) — used when an archived product is restored to active, mirroring
   * createWithCascade's default cascade.
   *
   * POS-PERF-P36R6 — excludes any branch where a fork-to-branch copy has
   * already replaced this product (replaceSharedProductAtBranch flipped the
   * copy on and the source off there). Without this, restoring the source
   * would silently put both the source and its replacement sellable at that
   * branch at once — the exact "restore re-publishes everywhere" conflict
   * flagged but left unfixed in docs/decisions/POS-PERF-P36R5-branch-copy-
   * ui-and-replacement.md §3. Every other branch this product sells at
   * (never replaced) still restores exactly as before.
   */
  async cascadeBranchAvailabilityOn(productId: string, updatedBy: string) {
    const replacingForks = await prisma.product.findMany({
      where: {
        forkedFromProductId: productId,
        branchExclusive: true,
        exclusiveBranchId: { not: null },
        branchAvailability: { some: { isAvailable: true } },
      },
      select: { exclusiveBranchId: true },
    });
    const replacedBranchIds = replacingForks.map((p) => p.exclusiveBranchId as string);

    return prisma.branchProductAvailability.updateMany({
      where: {
        productId,
        isAvailable: false,
        branch: { status: 'active' },
        ...(replacedBranchIds.length > 0 ? { branchId: { notIn: replacedBranchIds } } : {}),
      },
      data: { isAvailable: true, updatedBy },
    });
  },

  getProductsByGlobalStatus(statuses: PrismaProductStatus[]) {
    return prisma.product.findMany({ where: { status: { in: statuses } } });
  },

  allActiveBranches() {
    return prisma.branch.findMany({
      where: { status: 'active' },
      select: { id: true, code: true, name: true, city: true },
      orderBy: { name: 'asc' },
    });
  },

  findActiveBranch(branchId: string) {
    return prisma.branch.findFirst({ where: { id: branchId, status: 'active' }, select: { id: true, name: true } });
  },

  /** POS-PERF-P37 — the subset of these ids that reference an active branch (an absent id is unknown or inactive). */
  findActiveBranchesByIds(branchIds: string[], client: Prisma.TransactionClient | typeof prisma = prisma) {
    return client.branch.findMany({ where: { id: { in: branchIds }, status: 'active' }, select: { id: true, name: true } });
  },

  /**
   * POS-PERF-P38 — the shared configuration a publication depends on, for the
   * product's eligible variants (isActive + lifecycle ACTIVE, the same set
   * productReadinessService evaluates): active recipe components and the
   * option groups whose mapped inventory checkout deducts. Read-only.
   */
  findPublicationDependencies(productId: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
    return client.productVariant.findMany({
      where: { productId, isActive: true, lifecycleStatus: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        productComponents: {
          where: { isActive: true },
          select: {
            inventoryItemId: true,
            recipeUnitId: true,
            recipeUnit: { select: { code: true } },
            inventoryItem: publicationItemSelect,
          },
        },
        optionGroupAssignments: {
          select: {
            required: true,
            optionGroup: {
              select: { name: true, isActive: true, required: true, minSelections: true, options: { select: publicationOptionSelect } },
            },
            allowedOptions: { select: { productOption: { select: publicationOptionSelect } } },
          },
        },
      },
    });
  },

  /** POS-PERF-P38 — every conversion that could bridge these units for these items, in two queries (item-specific, then global). */
  findUnitConversionsFor(inventoryItemIds: string[], unitIds: string[], client: Prisma.TransactionClient | typeof prisma = prisma) {
    return Promise.all([
      client.inventoryItemUnitConversion.findMany({
        where: { inventoryItemId: { in: inventoryItemIds } },
        select: { inventoryItemId: true, fromUnitId: true, toUnitId: true },
      }),
      client.unitConversion.findMany({
        where: { fromUnitId: { in: unitIds }, toUnitId: { in: unitIds } },
        select: { fromUnitId: true, toUnitId: true },
      }),
    ]);
  },

  /**
   * POS-PERF-P38R2 — only what publication's target check reads (status and
   * branch-spread scope), instead of findById's full detail include.
   */
  findPublicationTarget(productId: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
    return client.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        status: true,
        branchExclusive: true,
        exclusiveBranchId: true,
        branchSelectionScoped: true,
        branchAvailability: { select: { branchId: true, isAvailable: true } },
      },
    });
  },

  /**
   * POS-PERF-P38R2 — upsertBranchProductAvailability(…, true, …) for several
   * branches in a fixed number of statements: insert the absent rows, set
   * every row available (updatedBy/updatedAt as an upsert would), then read
   * them back in `branchIds` order with the same shape as the upsert.
   */
  async publishBranchProductAvailability(branchIds: string[], productId: string, updatedBy: string, tx: Prisma.TransactionClient) {
    await tx.branchProductAvailability.createMany({
      data: branchIds.map((branchId) => ({ branchId, productId, isAvailable: true, updatedBy })),
      skipDuplicates: true,
    });
    // POS-PERF-P38R3 — only rows that are off: a retry of an already-published
    // branch leaves its row (updatedBy/updatedAt) exactly as it was.
    await tx.branchProductAvailability.updateMany({
      where: { productId, branchId: { in: branchIds }, isAvailable: false },
      data: { isAvailable: true, updatedBy },
    });
    const rows = await tx.branchProductAvailability.findMany({
      where: { productId, branchId: { in: branchIds } },
      include: { branch: { select: { id: true, code: true, name: true, city: true } } },
    });
    const byBranch = new Map(rows.map((row) => [row.branchId, row]));
    return branchIds.flatMap((branchId) => byBranch.get(branchId) ?? []);
  },

  /** POS-PERF-P38 — which (branch, item) InventoryStock rows already exist. Pass the transaction client to read inside one. */
  findStockPairs(branchIds: string[], inventoryItemIds: string[], tx: Prisma.TransactionClient | typeof prisma = prisma) {
    if (branchIds.length === 0 || inventoryItemIds.length === 0) return Promise.resolve([]);
    return tx.inventoryStock.findMany({
      where: { branchId: { in: branchIds }, inventoryItemId: { in: inventoryItemIds } },
      select: { branchId: true, inventoryItemId: true },
    });
  },

  /** Phase 10 POS terminal catalog — active products, available at this branch, with only active variants and available flavors. */
  findCatalogForBranch(branchId: string) {
    return prisma.product.findMany({
      where: {
        status: 'active',
        branchAvailability: { some: { branchId, isAvailable: true } },
      },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      include: {
        // CR-008 canonical category FK — POS catalog category tabs prefer
        // this over the legacy free-text `category` column (see getPosCatalog).
        productCategory: { select: { name: true, isActive: true } },
        variants: {
          where: { isActive: true },
          orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
          include: {
            variantFlavors: {
              where: { isAvailable: true, flavor: { isActive: true } },
              include: { flavor: { select: { id: true, name: true, colorHex: true } } },
            },
            // CR-008 R11/R12 — read-only, additive: assigned Option Groups
            // surfaced to the branch catalog view. Not consumed by pricing
            // or inventory deduction.
            optionGroupAssignments: {
              include: {
                optionGroup: {
                  select: {
                    id: true,
                    name: true,
                    posButtonLabel: true,
                    selectionType: true,
                    minSelections: true,
                    maxSelections: true,
                    required: true,
                    isActive: true,
                    // "All options" assignments (no allowedOptions rows) fall
                    // back to every active option in the group — see
                    // getPosCatalog's option_groups mapping.
                    options: {
                      where: { isActive: true },
                      orderBy: { sortOrder: 'asc' },
                      select: { id: true, name: true, priceAdjustment: true, sortOrder: true, isActive: true },
                    },
                  },
                },
                allowedOptions: {
                  orderBy: { sortOrder: 'asc' },
                  include: {
                    productOption: {
                      select: { id: true, name: true, priceAdjustment: true, sortOrder: true, isActive: true },
                    },
                  },
                },
              },
            },
            // Mix & Max flavor slots — one selector per row in the POS UI.
            flavorSlots: {
              orderBy: { slotIndex: 'asc' },
              include: {
                snackOptions: {
                  include: {
                    snackProductVariant: {
                      select: {
                        id: true,
                        name: true,
                        sizeLabel: true,
                        isActive: true,
                        product: {
                          select: {
                            id: true,
                            name: true,
                            status: true,
                            branchAvailability: { where: { branchId }, select: { isAvailable: true } },
                          },
                        },
                        variantFlavors: {
                          where: { isAvailable: true, flavor: { isActive: true } },
                          include: { flavor: { select: { id: true, name: true, colorHex: true } } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  },

  async findDisabledFlavorIds(branchId: string): Promise<string[]> {
    const rows = await prisma.branchFlavorAvailability.findMany({
      where: { branchId, isAvailable: false },
      select: { flavorId: true },
    });
    return rows.map((r) => r.flavorId);
  },

  // --- CR-005 Sub-phase 3c — variant lifecycle ---

  updateVariantLifecycle(
    variantId: string,
    updates: UpdateVariantLifecycleData,
    tx: Prisma.TransactionClient | typeof prisma = prisma,
  ) {
    return tx.productVariant.update({
      where: { id: variantId },
      data: {
        lifecycleStatus: updates.lifecycleStatus,
        version: updates.version,
        lastChangeReason: updates.lastChangeReason,
        approvedById: updates.approvedById,
        approvedAt: updates.approvedAt,
        name: updates.name,
        sizeLabel: updates.sizeLabel,
        basePrice: updates.basePrice,
        vatableCapAmount: updates.vatableCapAmount,
        displayOrder: updates.displayOrder,
        kcal: updates.kcal,
        maxFlavors: updates.maxFlavors,
      },
    });
  },

  insertVariantChangeLog(data: InsertVariantChangeLogData, tx: Prisma.TransactionClient | typeof prisma = prisma) {
    return tx.productChangeLog.create({ data });
  },

  countFlavorSlots(productVariantId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
    return tx.productFlavorSlot.count({ where: { productVariantId } });
  },

  // --- CR-005 Sub-phase 3d — flavor slot CRUD ---

  listVariantFlavorSlots(productVariantId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
    return tx.productFlavorSlot.findMany({
      where: { productVariantId },
      orderBy: { slotIndex: 'asc' },
      include: {
        snackOptions: {
          select: { id: true, snackProductVariantId: true, snackProductVariant: { select: { name: true, sizeLabel: true } } },
        },
      },
    });
  },

  findFlavorSlotById(slotId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
    return tx.productFlavorSlot.findUnique({ where: { id: slotId } });
  },

  // --- POS-PERF-P36R — Mix & Max snack-option CRUD (ProductFlavorSlot was
  // write-exposed; ProductFlavorSlotSnackOption, the "which snack variants
  // are sellable into this slot" row, had no write path at all). ---

  findSnackOptionById(id: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
    return tx.productFlavorSlotSnackOption.findUnique({ where: { id } });
  },

  insertSnackOption(data: { flavorSlotId: string; snackProductVariantId: string }, tx: Prisma.TransactionClient | typeof prisma = prisma) {
    return tx.productFlavorSlotSnackOption.create({ data });
  },

  deleteSnackOption(id: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
    return tx.productFlavorSlotSnackOption.delete({ where: { id } });
  },

  insertFlavorSlot(
    data: {
      productVariantId: string;
      slotIndex: number;
      label: string;
      flavorQty: Prisma.Decimal;
      unit: string;
      required: boolean;
    },
    tx: Prisma.TransactionClient | typeof prisma = prisma,
  ) {
    return tx.productFlavorSlot.create({ data });
  },

  updateFlavorSlot(
    slotId: string,
    data: {
      label?: string;
      flavorQty?: Prisma.Decimal;
      unit?: string;
      required?: boolean;
    },
    tx: Prisma.TransactionClient | typeof prisma = prisma,
  ) {
    return tx.productFlavorSlot.update({ where: { id: slotId }, data });
  },

  deleteFlavorSlot(slotId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
    return tx.productFlavorSlot.delete({ where: { id: slotId } });
  },

  /** Removal shifts every higher slotIndex down by 1 to keep 0..N-1 contiguity (Decision M). Two-phase (+10000 offset, then final) avoids tripping the (productVariantId, slotIndex) unique constraint mid-loop. */
  async shiftFlavorSlotIndicesDown(
    productVariantId: string,
    startingFromIndex: number,
    tx: Prisma.TransactionClient | typeof prisma = prisma,
  ): Promise<void> {
    const affected = await tx.productFlavorSlot.findMany({
      where: { productVariantId, slotIndex: { gt: startingFromIndex } },
      orderBy: { slotIndex: 'asc' },
    });
    if (affected.length === 0) return;

    const TEMP_OFFSET = 10000;
    for (const slot of affected) {
      await tx.productFlavorSlot.update({ where: { id: slot.id }, data: { slotIndex: slot.slotIndex + TEMP_OFFSET } });
    }
    for (const slot of affected) {
      await tx.productFlavorSlot.update({ where: { id: slot.id }, data: { slotIndex: slot.slotIndex - 1 } });
    }
  },

  /** Rewrites every slot's slotIndex to match its position in orderedSlotIds (Decision L). Same two-phase temp-offset pattern as shiftFlavorSlotIndicesDown. Every update is scoped to productVariantId as a defense-in-depth guard against cross-variant contamination. */
  async rewriteFlavorSlotOrder(
    productVariantId: string,
    orderedSlotIds: string[],
    tx: Prisma.TransactionClient | typeof prisma = prisma,
  ): Promise<void> {
    const TEMP_OFFSET = 10000;
    for (const [i, slotId] of orderedSlotIds.entries()) {
      await tx.productFlavorSlot.updateMany({ where: { id: slotId, productVariantId }, data: { slotIndex: i + TEMP_OFFSET } });
    }
    for (const [i, slotId] of orderedSlotIds.entries()) {
      await tx.productFlavorSlot.updateMany({ where: { id: slotId, productVariantId }, data: { slotIndex: i } });
    }
  },

  countVariantFlavorSlots(productVariantId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
    return tx.productFlavorSlot.count({ where: { productVariantId } });
  },

  // --- Task 209.6 — Product Image Management (Admin Only) ---

  /** Narrow lookup for the image endpoints — avoids detailInclude's variant/flavor/branch joins when only imagePath is needed. createdBy lets the service scope supervisor uploads to products they created (POS-PERF-P34). */
  findImagePath(productId: string) {
    return prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        imagePath: true,
        createdBy: true,
        managedBy: true,
        branchExclusive: true,
        exclusiveBranchId: true,
        // POS-PERF-P36 — see findVariantById's identical comment.
        branchAvailability: { select: { branchId: true, isAvailable: true } },
      },
    });
  },

  /** Single-column update — never touches variants, recipes, inventory, pricing, or availability rows. No transaction needed: one row, one column. */
  updateImagePath(productId: string, imagePath: string | null) {
    return prisma.product.update({ where: { id: productId }, data: { imagePath }, select: { id: true, imagePath: true } });
  },
};
