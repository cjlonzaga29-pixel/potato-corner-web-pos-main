import { Prisma } from '@prisma/client';
import {
  PRODUCT_CLASSIFICATIONS,
  PRODUCT_CLASSIFICATION_LABELS,
  ROLES,
  isBuiltInProductTypeKey,
  isReservedProductTypeName,
  normalizeProductTypeName,
  type CreateProductTypeInput,
  type JwtPayload,
  type ProductClassification,
  type ProductTypeResponse,
  type UpdateProductTypeInput,
} from '@potato-corner/shared';
import { z } from 'zod';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { getAccessibleBranchIds, hasBranchAccess } from '../../lib/branch-access.js';
import { branchesRepository } from '../branches/branches.repository.js';
import { productTypesRepository, type ProductTypeRow } from './product-types.repository.js';
import { ProductTypeError, type ProductTypeListFilters } from './product-types.types.js';

type ActorContext = { id: string; role: string };

const BUILT_IN_DESCRIPTIONS: Record<ProductClassification, string> = {
  regular: 'An everyday menu item.',
  promotional: 'An item that can be given a promotion.',
  seasonal: 'A limited-time item that can be given a promotion.',
};

/** Built-ins are classification values, not rows: nothing here can rename, deactivate or delete them. */
function builtInResponses(): ProductTypeResponse[] {
  return PRODUCT_CLASSIFICATIONS.map((key) => ({
    key,
    id: null,
    name: PRODUCT_CLASSIFICATION_LABELS[key],
    description: BUILT_IN_DESCRIPTIONS[key],
    is_builtin: true,
    is_active: true,
    version: 0,
    branches: [],
    can_manage: false,
    product_count: null,
  }));
}

function toResponse(row: ProductTypeRow, liveBranchIds: 'all' | string[], productCount: number, role: string): ProductTypeResponse {
  return {
    key: row.id,
    id: row.id,
    name: row.name,
    description: row.description,
    is_builtin: false,
    is_active: row.isActive,
    version: row.version,
    branches: row.branches.map((b) => ({ branch_id: b.branchId, branch_name: b.branch.name })).sort((a, b) => a.branch_name.localeCompare(b.branch_name)),
    can_manage: role === ROLES.SUPERVISOR && liveBranchIds !== 'all' && row.branches.every((b) => liveBranchIds.includes(b.branchId)),
    product_count: productCount,
  };
}

function isNameCollision(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

const nameTaken = (name: string) => new ProductTypeError('PRODUCT_TYPE_NAME_TAKEN', `An active product type named "${name}" already exists at one of these branches.`, 409);
const conflict = () =>
  new ProductTypeError('PRODUCT_TYPE_CONFLICT', 'This product type was changed by someone else since you loaded it. Reload to see the latest version before saving again.', 409);

/**
 * The type as its manager may act on it. Same rule as a shared product
 * (catalog-authority.ts): overlap lets a supervisor see and use a type, but only
 * covering its whole scope lets them change it. Assignments are read live, never
 * from the JWT, so a revoked one stops working at once.
 */
async function loadManageable(productTypeId: string, actor: ActorContext) {
  if (isBuiltInProductTypeKey(productTypeId)) {
    throw new ProductTypeError('PRODUCT_TYPE_BUILT_IN', 'Regular, Promotional and Seasonal are built in and cannot be changed.', 409);
  }
  const notFound = new ProductTypeError('PRODUCT_TYPE_NOT_FOUND', 'Product type not found', 404);
  if (!z.uuid().safeParse(productTypeId).success) throw notFound;
  const row = await productTypesRepository.findById(productTypeId);
  if (!row) throw notFound;
  const liveBranchIds = await branchesRepository.findAllActiveBranchIds(actor.id);
  if (!row.branches.some((b) => liveBranchIds.includes(b.branchId))) throw notFound;
  if (!row.branches.every((b) => liveBranchIds.includes(b.branchId))) {
    throw new ProductTypeError('PRODUCT_TYPE_SCOPE_FORBIDDEN', 'This product type is shared with a branch outside your assignment, so you can use it but not change it.', 403);
  }
  return { row, liveBranchIds };
}

async function assertBranchesAssignable(branchIds: string[], liveBranchIds: string[]): Promise<void> {
  const active = await productTypesRepository.findActiveBranchIds(branchIds);
  if (active.length !== branchIds.length) {
    throw new ProductTypeError('BRANCH_SELECTION_INVALID', 'One or more selected branches do not exist or are inactive', 422);
  }
  if (!branchIds.every((id) => liveBranchIds.includes(id))) {
    throw new ProductTypeError('BRANCH_ACCESS_DENIED', 'You do not have an active assignment to every selected branch', 403);
  }
}

export const productTypesService = {
  async list(user: JwtPayload, filters: ProductTypeListFilters) {
    if (filters.branch_id && !(await hasBranchAccess(user, filters.branch_id))) {
      throw new ProductTypeError('BRANCH_ACCESS_DENIED', 'You do not have access to this branch', 403);
    }
    const accessible = await getAccessibleBranchIds(user);
    const rows = await productTypesRepository.findMany({
      includeInactive: filters.include_inactive,
      ...(filters.branch_id ? { branchIds: [filters.branch_id] } : accessible !== 'all' ? { branchIds: accessible } : {}),
    });
    const counts = await productTypesRepository.countProductsByType(rows.map((row) => row.id));
    return { types: [...builtInResponses(), ...rows.map((row) => toResponse(row, accessible, counts.get(row.id) ?? 0, user.role))] };
  },

  async create(data: CreateProductTypeInput, actor: ActorContext, ipAddress: string | null) {
    const branchIds = [...new Set(data.branch_ids)];
    const liveBranchIds = await branchesRepository.findAllActiveBranchIds(actor.id);
    await assertBranchesAssignable(branchIds, liveBranchIds);

    let row;
    try {
      row = await productTypesRepository.create({
        name: data.name,
        normalizedName: normalizeProductTypeName(data.name),
        description: data.description || null,
        branchIds,
        createdById: actor.id,
      });
    } catch (error) {
      if (isNameCollision(error)) throw nameTaken(data.name);
      throw error;
    }

    const response = toResponse(row, liveBranchIds, 0, actor.role);
    await recordAuditLog({ action: 'PRODUCT_TYPE_CREATED', entityType: 'product_type', entityId: row.id, actorId: actor.id, actorRole: actor.role, afterState: response, ipAddress });
    return response;
  },

  async update(productTypeId: string, data: UpdateProductTypeInput, actor: ActorContext, ipAddress: string | null) {
    const { row: before, liveBranchIds } = await loadManageable(productTypeId, actor);
    if (data.name !== undefined && isReservedProductTypeName(data.name)) {
      throw new ProductTypeError('PRODUCT_TYPE_NAME_RESERVED', 'Regular, Promotional and Seasonal already exist', 422);
    }

    const current = before.branches.map((b) => b.branchId);
    const next = data.branch_ids ? [...new Set(data.branch_ids)] : current;
    if (current.some((id) => !next.includes(id))) {
      throw new ProductTypeError('PRODUCT_TYPE_SCOPE_NARROWING', 'A branch cannot be removed from a product type. Create a new type for the smaller scope instead.', 422);
    }
    const added = next.filter((id) => !current.includes(id));
    if (added.length > 0) await assertBranchesAssignable(added, liveBranchIds);

    let row;
    try {
      row = await productTypesRepository.update(
        productTypeId,
        {
          ...(data.name !== undefined && { name: data.name, normalizedName: normalizeProductTypeName(data.name) }),
          ...(data.description !== undefined && { description: data.description || null }),
          updatedById: actor.id,
        },
        data.expected_version,
        added,
      );
    } catch (error) {
      if (isNameCollision(error)) throw nameTaken(data.name ?? before.name);
      throw error;
    }
    if (!row) throw conflict();

    const counts = await productTypesRepository.countProductsByType([row.id]);
    const response = toResponse(row, liveBranchIds, counts.get(row.id) ?? 0, actor.role);
    await recordAuditLog({
      action: 'PRODUCT_TYPE_UPDATED',
      entityType: 'product_type',
      entityId: row.id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toResponse(before, liveBranchIds, counts.get(row.id) ?? 0, actor.role),
      afterState: response,
      ipAddress,
    });
    return response;
  },

  /** Stops new assignments and nothing else. Reactivating refuses a name another active type now holds. */
  async setActive(productTypeId: string, isActive: boolean, expectedVersion: number, actor: ActorContext, ipAddress: string | null) {
    const { row: before, liveBranchIds } = await loadManageable(productTypeId, actor);
    const counts = await productTypesRepository.countProductsByType([before.id]);
    const productCount = counts.get(before.id) ?? 0;
    // A retry of a change that already happened.
    if (before.isActive === isActive) return toResponse(before, liveBranchIds, productCount, actor.role);

    let row;
    try {
      row = await productTypesRepository.setActive(productTypeId, isActive, expectedVersion, actor.id);
    } catch (error) {
      if (isNameCollision(error)) throw nameTaken(before.name);
      throw error;
    }
    if (!row) throw conflict();

    const response = toResponse(row, liveBranchIds, productCount, actor.role);
    await recordAuditLog({
      action: isActive ? 'PRODUCT_TYPE_REACTIVATED' : 'PRODUCT_TYPE_DEACTIVATED',
      entityType: 'product_type',
      entityId: row.id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: { is_active: before.isActive },
      afterState: { is_active: row.isActive, product_count: productCount },
      ipAddress,
    });
    return response;
  },
};
