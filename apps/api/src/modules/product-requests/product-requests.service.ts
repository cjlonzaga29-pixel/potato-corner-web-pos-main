import { ROLES, type JwtPayload, type ProposedFlavor, type ProposedRecipe, type ProposedVariant } from '@potato-corner/shared';
import { productRequestsRepository } from './product-requests.repository.js';
import { ProductRequestError, type ProductRequestListFilters } from './product-requests.types.js';
import { productsRepository } from '../products/products.repository.js';
import { flavorsRepository } from '../flavors/flavors.repository.js';
import { recipesRepository } from '../recipes/recipes.repository.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { notifySuperAdmin, notifyBranch } from '../../lib/notify.js';
import { SOCKET_EVENTS } from '@potato-corner/shared';
import { getAccessibleBranchIds } from '../../lib/branch-access.js';

type ActorContext = { id: string; role: string };

interface RequestRow {
  id: string;
  branchId: string;
  requestedBy: string;
  proposedName: string;
  proposedDescription: string | null;
  proposedCategory: string | null;
  proposedVariants: unknown;
  proposedFlavors: unknown;
  proposedRecipes: unknown;
  requestReason: string;
  status: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  createdProductId: string | null;
  createdAt: Date;
  updatedAt: Date;
  branch: { id: string; name: string; code: string };
  requester: { id: string; firstName: string; lastName: string };
  reviewer: { id: string; firstName: string; lastName: string } | null;
}

function toResponse(row: RequestRow) {
  return {
    id: row.id,
    branch_id: row.branchId,
    branch_name: row.branch.name,
    requested_by: row.requestedBy,
    requested_by_name: `${row.requester.firstName} ${row.requester.lastName}`,
    proposed_name: row.proposedName,
    proposed_description: row.proposedDescription,
    proposed_category: row.proposedCategory,
    proposed_variants: row.proposedVariants,
    proposed_flavors: row.proposedFlavors,
    proposed_recipes: row.proposedRecipes,
    request_reason: row.requestReason,
    status: row.status,
    reviewed_by: row.reviewedBy,
    reviewed_by_name: row.reviewer ? `${row.reviewer.firstName} ${row.reviewer.lastName}` : null,
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    review_notes: row.reviewNotes,
    created_product_id: row.createdProductId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

interface CreateProductRequestInput {
  branch_id: string;
  proposed_name: string;
  proposed_description?: string;
  proposed_category?: string;
  proposed_variants: ProposedVariant[];
  proposed_flavors: ProposedFlavor[];
  proposed_recipes: ProposedRecipe[];
  request_reason: string;
}

interface ReviewProductRequestInput {
  action: 'approve' | 'reject';
  review_notes?: string;
  overrides?: {
    proposed_name?: string;
    proposed_description?: string;
    proposed_category?: string;
    proposed_variants?: ProposedVariant[];
  };
}

export const productRequestsService = {
  /** Supervisor-only. branch_id must be one of the actor's own assigned branches. */
  async submitRequest(data: CreateProductRequestInput, actor: JwtPayload, ipAddress: string | null) {
    if (actor.role !== ROLES.SUPERVISOR) {
      throw new ProductRequestError('INSUFFICIENT_PERMISSIONS', 'Only supervisors may submit product requests', 403);
    }
    if (!actor.branch_ids.includes(data.branch_id)) {
      throw new ProductRequestError('BRANCH_ACCESS_DENIED', 'You may only submit requests for your own branch', 403);
    }

    const created = (await productRequestsRepository.create(
      {
        branchId: data.branch_id,
        proposedName: data.proposed_name,
        proposedDescription: data.proposed_description,
        proposedCategory: data.proposed_category,
        proposedVariants: data.proposed_variants,
        proposedFlavors: data.proposed_flavors,
        proposedRecipes: data.proposed_recipes,
        requestReason: data.request_reason,
      },
      actor.user_id,
    )) as RequestRow;
    const response = toResponse(created);

    await recordAuditLog({
      action: 'PRODUCT_REQUEST_SUBMITTED',
      entityType: 'product_request',
      entityId: created.id,
      actorId: actor.user_id,
      actorRole: actor.role,
      branchId: data.branch_id,
      afterState: response,
      ipAddress,
    });

    notifySuperAdmin(SOCKET_EVENTS.PRODUCT_REQUEST_SUBMITTED, response);

    return response;
  },

  /** super_admin sees everything; supervisor is scoped to their own branch_ids regardless of query filters. */
  async listRequests(actor: JwtPayload, filters: Omit<ProductRequestListFilters, 'branchIds'>) {
    const branchIds = getAccessibleBranchIds(actor);
    // Supervisors are always scoped to their own branch — a client-supplied
    // branch_id outside that scope is silently overridden, never rejected,
    // matching flavor-requests.service.ts's listRequests convention.
    const scoped =
      actor.role === ROLES.SUPERVISOR
        ? { ...filters, branch_id: filters.branch_id && actor.branch_ids.includes(filters.branch_id) ? filters.branch_id : actor.branch_ids[0] }
        : filters;

    const { requests, total } = await productRequestsRepository.findAll({ ...scoped, branchIds });
    return {
      requests: (requests as RequestRow[]).map(toResponse),
      total,
      page: filters.page,
      limit: filters.limit,
    };
  },

  async getRequestById(id: string, actor: JwtPayload) {
    const request = (await productRequestsRepository.findById(id)) as RequestRow | null;
    if (!request) throw new ProductRequestError('PRODUCT_REQUEST_NOT_FOUND', 'Product request not found', 404);
    if (actor.role === ROLES.SUPERVISOR && !actor.branch_ids.includes(request.branchId)) {
      throw new ProductRequestError('BRANCH_ACCESS_DENIED', 'You may only view requests for your own branch', 403);
    }
    return toResponse(request);
  },

  async reviewRequest(id: string, data: ReviewProductRequestInput, actor: ActorContext, ipAddress: string | null) {
    const request = (await productRequestsRepository.findById(id)) as RequestRow | null;
    if (!request) throw new ProductRequestError('PRODUCT_REQUEST_NOT_FOUND', 'Product request not found', 404);
    if (request.status !== 'pending') {
      throw new ProductRequestError('PRODUCT_REQUEST_ALREADY_REVIEWED', 'This request has already been reviewed', 409);
    }

    if (data.action === 'reject') {
      const updated = (await productRequestsRepository.updateStatus(id, {
        status: 'rejected',
        reviewedBy: actor.id,
        reviewNotes: data.review_notes,
      })) as RequestRow;
      const response = toResponse(updated);

      await recordAuditLog({
        action: 'PRODUCT_REQUEST_REJECTED',
        entityType: 'product_request',
        entityId: id,
        actorId: actor.id,
        actorRole: actor.role,
        branchId: request.branchId,
        beforeState: toResponse(request),
        afterState: response,
        ipAddress,
      });

      notifyBranch(request.branchId, SOCKET_EVENTS.PRODUCT_REQUEST_REVIEWED, response);
      return response;
    }

    // Approve: create the master-catalog product (branch_exclusive true to
    // the requesting branch), its variants, flavor links, and recipes —
    // from the (optionally admin-edited) proposal.
    const finalName = data.overrides?.proposed_name ?? request.proposedName;
    const finalDescription = data.overrides?.proposed_description ?? request.proposedDescription ?? undefined;
    const finalCategory = data.overrides?.proposed_category ?? request.proposedCategory ?? undefined;
    const finalVariants = (data.overrides?.proposed_variants ?? (request.proposedVariants as ProposedVariant[])) as ProposedVariant[];
    const proposedFlavors = request.proposedFlavors as ProposedFlavor[];
    const proposedRecipes = request.proposedRecipes as ProposedRecipe[];

    const { product: createdProduct } = await productsRepository.createWithCascade(
      {
        name: finalName,
        description: finalDescription,
        category: finalCategory,
        status: 'active',
        isSeasonal: false,
        branchExclusive: true,
        exclusiveBranchId: request.branchId,
      },
      actor.id,
    );

    const createdVariants = [];
    for (const proposedVariant of finalVariants) {
      const variant = await productsRepository.createVariant(createdProduct.id, {
        name: proposedVariant.name,
        sizeLabel: proposedVariant.size_label,
        basePrice: proposedVariant.base_price,
        displayOrder: proposedVariant.display_order,
        isActive: true,
      });
      createdVariants.push(variant);
    }

    const flavorIdByProposalIndex: (string | undefined)[] = [];
    for (const proposedFlavor of proposedFlavors) {
      let flavorId = proposedFlavor.flavor_id;
      if (!flavorId && proposedFlavor.name) {
        const existing = await flavorsRepository.findByName(proposedFlavor.name);
        const flavor = existing ?? (await flavorsRepository.create({ name: proposedFlavor.name, colorHex: '#CCCCCC', isActive: true }));
        flavorId = flavor.id;
      }
      flavorIdByProposalIndex.push(flavorId);
      if (flavorId) {
        for (const variant of createdVariants) {
          const existingLink = await flavorsRepository.findVariantFlavorLink(variant.id, flavorId);
          if (!existingLink) {
            await flavorsRepository.linkVariantFlavor(variant.id, flavorId, proposedFlavor.price_premium ?? 0, true);
          }
        }
      }
    }

    for (const proposedRecipe of proposedRecipes) {
      const variant = createdVariants[proposedRecipe.variant_index];
      if (!variant) continue;
      await recipesRepository.createRecipe({
        productVariantId: variant.id,
        ingredientId: proposedRecipe.ingredient_id,
        flavorId: proposedRecipe.flavor_id ?? null,
        quantity: proposedRecipe.quantity,
        unit: proposedRecipe.unit,
      });
    }

    const updated = (await productRequestsRepository.updateStatus(id, {
      status: 'approved',
      reviewedBy: actor.id,
      reviewNotes: data.review_notes,
      createdProductId: createdProduct.id,
    })) as RequestRow;
    const response = toResponse(updated);

    await recordAuditLog({
      action: 'PRODUCT_REQUEST_APPROVED',
      entityType: 'product_request',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: request.branchId,
      beforeState: toResponse(request),
      afterState: { ...response, createdVariantIds: createdVariants.map((v) => v.id) },
      ipAddress,
    });

    notifyBranch(request.branchId, SOCKET_EVENTS.PRODUCT_REQUEST_REVIEWED, response);
    return response;
  },
};
