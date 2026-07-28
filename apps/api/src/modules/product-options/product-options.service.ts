import type { JwtPayload } from '@potato-corner/shared';
import { productOptionsRepository as repo } from './product-options.repository.js';
import { ProductOptionError, type OptionGroupListFilters, type SelectionType } from './product-options.types.js';
import { productsRepository } from '../products/products.repository.js';
import { ProductError } from '../products/products.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';

type ActorContext = { id: string; role: string };
type Decimalish = { toNumber(): number };

function toGroupResponse(group: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  selectionType: SelectionType;
  minSelections: number;
  maxSelections: number | null;
  required: boolean;
  isActive: boolean;
  sortOrder: number | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { options: number };
}) {
  return {
    id: group.id,
    code: group.code,
    name: group.name,
    description: group.description,
    selection_type: group.selectionType,
    min_selections: group.minSelections,
    max_selections: group.maxSelections,
    required: group.required,
    is_active: group.isActive,
    sort_order: group.sortOrder,
    option_count: group._count?.options ?? 0,
    created_at: group.createdAt.toISOString(),
    updated_at: group.updatedAt.toISOString(),
  };
}

function toOptionResponse(option: {
  id: string;
  optionGroupId: string;
  code: string;
  name: string;
  priceAdjustment: Decimalish;
  imageUrl: string | null;
  isActive: boolean;
  sortOrder: number | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: option.id,
    option_group_id: option.optionGroupId,
    code: option.code,
    name: option.name,
    price_adjustment: option.priceAdjustment.toNumber(),
    image_url: option.imageUrl,
    is_active: option.isActive,
    sort_order: option.sortOrder,
    created_at: option.createdAt.toISOString(),
    updated_at: option.updatedAt.toISOString(),
  };
}

function toVariantOptionGroupResponse(assignment: {
  id: string;
  productVariantId: string;
  optionGroupId: string;
  required: boolean | null;
  sortOrder: number | null;
  optionGroup: {
    code: string;
    name: string;
    selectionType: SelectionType;
    minSelections: number;
    maxSelections: number | null;
    required: boolean;
  };
  allowedOptions: {
    sortOrder: number | null;
    productOption: {
      id: string;
      code: string;
      name: string;
      priceAdjustment: Decimalish;
      isActive: boolean;
    };
  }[];
}) {
  return {
    id: assignment.id,
    product_variant_id: assignment.productVariantId,
    option_group_id: assignment.optionGroupId,
    code: assignment.optionGroup.code,
    name: assignment.optionGroup.name,
    selection_type: assignment.optionGroup.selectionType,
    min_selections: assignment.optionGroup.minSelections,
    max_selections: assignment.optionGroup.maxSelections,
    required: assignment.required ?? assignment.optionGroup.required,
    sort_order: assignment.sortOrder,
    allowed_options: assignment.allowedOptions.map((row) => ({
      product_option_id: row.productOption.id,
      code: row.productOption.code,
      name: row.productOption.name,
      price_adjustment: row.productOption.priceAdjustment.toNumber(),
      is_active: row.productOption.isActive,
      sort_order: row.sortOrder,
    })),
  };
}

interface CreateOptionGroupInput {
  code: string;
  name: string;
  description?: string;
  selection_type: SelectionType;
  min_selections: number;
  max_selections?: number;
  required: boolean;
  is_active: boolean;
  sort_order?: number;
}

interface UpdateOptionGroupInput {
  name?: string;
  description?: string;
  selection_type?: SelectionType;
  min_selections?: number;
  max_selections?: number | null;
  required?: boolean;
  is_active?: boolean;
  sort_order?: number;
}

interface CreateOptionInput {
  code: string;
  name: string;
  price_adjustment: number;
  image_url?: string;
  is_active: boolean;
  sort_order?: number;
}

interface UpdateOptionInput {
  name?: string;
  price_adjustment?: number;
  image_url?: string | null;
  is_active?: boolean;
  sort_order?: number;
}

interface AssignVariantOptionGroupInput {
  option_group_id: string;
  required?: boolean | null;
  sort_order?: number;
  allowed_option_ids?: string[];
}

interface UpdateVariantOptionGroupInput {
  required?: boolean | null;
  sort_order?: number;
  allowed_option_ids?: string[];
}

async function assertOptionIdsBelongToGroup(optionGroupId: string, optionIds: string[]): Promise<void> {
  if (optionIds.length === 0) return;
  const unique = new Set(optionIds);
  if (unique.size !== optionIds.length) {
    throw new ProductOptionError('DUPLICATE_ALLOWED_OPTION', 'allowed_option_ids must not contain duplicates', 422);
  }
  for (const optionId of unique) {
    const option = await repo.findOptionById(optionId);
    if (!option || option.optionGroupId !== optionGroupId) {
      throw new ProductOptionError('OPTION_NOT_IN_GROUP', `Option ${optionId} does not belong to the assigned option group`, 422);
    }
  }
}

export const productOptionsService = {
  // --- Option Groups (R4) ---

  async getAllGroups(_requestingUser: JwtPayload, filters: OptionGroupListFilters) {
    const { groups, total } = await repo.findAllGroups(filters);
    return { option_groups: groups.map(toGroupResponse), total, page: filters.page, limit: filters.limit };
  },

  async getGroupById(id: string) {
    const group = await repo.findGroupById(id);
    if (!group) throw new ProductOptionError('OPTION_GROUP_NOT_FOUND', 'Product option group not found', 404);
    return { ...toGroupResponse({ ...group, _count: { options: group.options.length } }), options: group.options.map(toOptionResponse) };
  },

  async createGroup(data: CreateOptionGroupInput, actor: ActorContext, ipAddress: string | null) {
    const existing = await repo.findGroupByCode(data.code);
    if (existing) throw new ProductOptionError('OPTION_GROUP_CODE_CONFLICT', `An option group with code "${data.code}" already exists`, 409);

    const group = await repo.createGroup({
      code: data.code,
      name: data.name,
      description: data.description,
      selectionType: data.selection_type,
      minSelections: data.min_selections,
      maxSelections: data.max_selections,
      required: data.required,
      isActive: data.is_active,
      sortOrder: data.sort_order,
      createdBy: actor.id,
    });
    const response = toGroupResponse(group);

    await recordAuditLog({
      action: 'PRODUCT_OPTION_GROUP_CREATED',
      entityType: 'product_option_group',
      entityId: group.id,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async updateGroup(id: string, data: UpdateOptionGroupInput, actor: ActorContext, ipAddress: string | null) {
    const before = await repo.findGroupById(id);
    if (!before) throw new ProductOptionError('OPTION_GROUP_NOT_FOUND', 'Product option group not found', 404);

    const group = await repo.updateGroup(id, {
      name: data.name,
      description: data.description,
      selectionType: data.selection_type,
      minSelections: data.min_selections,
      maxSelections: data.max_selections,
      required: data.required,
      isActive: data.is_active,
      sortOrder: data.sort_order,
    });
    const response = toGroupResponse(group);

    await recordAuditLog({
      action: 'PRODUCT_OPTION_GROUP_UPDATED',
      entityType: 'product_option_group',
      entityId: group.id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toGroupResponse({ ...before, _count: { options: before.options.length } }),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  // --- Options (R5) ---

  async createOption(optionGroupId: string, data: CreateOptionInput, actor: ActorContext, ipAddress: string | null) {
    const group = await repo.findGroupById(optionGroupId);
    if (!group) throw new ProductOptionError('OPTION_GROUP_NOT_FOUND', 'Product option group not found', 404);

    const existing = await repo.findOptionByCode(optionGroupId, data.code);
    if (existing) {
      throw new ProductOptionError('OPTION_CODE_CONFLICT', `An option with code "${data.code}" already exists in this group`, 409);
    }

    const option = await repo.createOption({
      optionGroupId,
      code: data.code,
      name: data.name,
      priceAdjustment: data.price_adjustment,
      imageUrl: data.image_url,
      isActive: data.is_active,
      sortOrder: data.sort_order,
      createdBy: actor.id,
    });
    const response = toOptionResponse(option);

    await recordAuditLog({
      action: 'PRODUCT_OPTION_CREATED',
      entityType: 'product_option',
      entityId: option.id,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async updateOption(optionGroupId: string, optionId: string, data: UpdateOptionInput, actor: ActorContext, ipAddress: string | null) {
    const before = await repo.findOptionById(optionId);
    if (!before || before.optionGroupId !== optionGroupId) {
      throw new ProductOptionError('OPTION_NOT_FOUND', 'Product option not found', 404);
    }

    const option = await repo.updateOption(optionId, {
      name: data.name,
      priceAdjustment: data.price_adjustment,
      imageUrl: data.image_url,
      isActive: data.is_active,
      sortOrder: data.sort_order,
    });
    const response = toOptionResponse(option);

    await recordAuditLog({
      action: 'PRODUCT_OPTION_UPDATED',
      entityType: 'product_option',
      entityId: option.id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toOptionResponse(before),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  // --- Variant <-> Option Group assignment (R6) ---

  async listVariantOptionGroups(productId: string, variantId: string) {
    const variant = await productsRepository.findVariantById(variantId);
    if (!variant || variant.productId !== productId) throw new ProductError('VARIANT_NOT_FOUND', 'Variant not found', 404);

    const assignments = await repo.findVariantOptionGroups(variantId);
    return assignments.map(toVariantOptionGroupResponse);
  },

  async assignOptionGroupToVariant(
    productId: string,
    variantId: string,
    data: AssignVariantOptionGroupInput,
    actor: ActorContext,
    ipAddress: string | null,
  ) {
    const variant = await productsRepository.findVariantById(variantId);
    if (!variant || variant.productId !== productId) throw new ProductError('VARIANT_NOT_FOUND', 'Variant not found', 404);

    const group = await repo.findGroupById(data.option_group_id);
    if (!group) throw new ProductOptionError('OPTION_GROUP_NOT_FOUND', 'Product option group not found', 404);

    const existingAssignment = await repo.findVariantOptionGroupAssignment(variantId, data.option_group_id);
    if (existingAssignment) {
      throw new ProductOptionError('VARIANT_OPTION_GROUP_ALREADY_ASSIGNED', 'This option group is already assigned to this variant', 409);
    }

    const allowedOptionIds = data.allowed_option_ids ?? [];
    await assertOptionIdsBelongToGroup(data.option_group_id, allowedOptionIds);

    const assignment = await repo.assignOptionGroup(variantId, {
      optionGroupId: data.option_group_id,
      required: data.required,
      sortOrder: data.sort_order,
      allowedOptionIds,
      createdBy: actor.id,
    });
    const response = toVariantOptionGroupResponse(assignment);

    await recordAuditLog({
      action: 'VARIANT_OPTION_GROUP_ASSIGNED',
      entityType: 'product_variant_option_group',
      entityId: assignment.id,
      actorId: actor.id,
      actorRole: actor.role,
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async updateVariantOptionGroup(
    productId: string,
    variantId: string,
    assignmentId: string,
    data: UpdateVariantOptionGroupInput,
    actor: ActorContext,
    ipAddress: string | null,
  ) {
    const variant = await productsRepository.findVariantById(variantId);
    if (!variant || variant.productId !== productId) throw new ProductError('VARIANT_NOT_FOUND', 'Variant not found', 404);

    const before = await repo.findVariantOptionGroupById(assignmentId);
    if (!before || before.productVariantId !== variantId) {
      throw new ProductOptionError('VARIANT_OPTION_GROUP_NOT_FOUND', 'This option group is not assigned to this variant', 404);
    }

    if (data.allowed_option_ids !== undefined) {
      await assertOptionIdsBelongToGroup(before.optionGroupId, data.allowed_option_ids);
    }

    const assignment = await repo.updateVariantOptionGroup(assignmentId, {
      required: data.required,
      sortOrder: data.sort_order,
      allowedOptionIds: data.allowed_option_ids,
    });
    const response = toVariantOptionGroupResponse(assignment);

    await recordAuditLog({
      action: 'VARIANT_OPTION_GROUP_UPDATED',
      entityType: 'product_variant_option_group',
      entityId: assignmentId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toVariantOptionGroupResponse(before),
      afterState: response,
      ipAddress,
    });

    return response;
  },

  async unassignOptionGroupFromVariant(productId: string, variantId: string, assignmentId: string, actor: ActorContext, ipAddress: string | null) {
    const variant = await productsRepository.findVariantById(variantId);
    if (!variant || variant.productId !== productId) throw new ProductError('VARIANT_NOT_FOUND', 'Variant not found', 404);

    const before = await repo.findVariantOptionGroupById(assignmentId);
    if (!before || before.productVariantId !== variantId) {
      throw new ProductOptionError('VARIANT_OPTION_GROUP_NOT_FOUND', 'This option group is not assigned to this variant', 404);
    }

    await repo.deleteVariantOptionGroup(assignmentId);

    await recordAuditLog({
      action: 'VARIANT_OPTION_GROUP_UNASSIGNED',
      entityType: 'product_variant_option_group',
      entityId: assignmentId,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: toVariantOptionGroupResponse(before),
      ipAddress,
    });
  },
};
