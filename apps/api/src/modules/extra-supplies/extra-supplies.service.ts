import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import sharp from 'sharp';
import {
  ROLES,
  availableIssueQuantity,
  normalizeExtraSupplyName,
  type CreateExtraSupplyInput,
  type ExtraSupplyIssueListQuery,
  type ExtraSupplyIssueSummaryQuery,
  type ExtraSupplyListQuery,
  type ExtraSupplyResponse,
  type ExtraSupplySummaryResponse,
  type JwtPayload,
  type UpdateExtraSupplyInput,
} from '@potato-corner/shared';
import type { z } from 'zod';
import { createExtraSupplyIssueSchema } from '@potato-corner/shared';
import { config } from '../../config/index.js';
import { assertBranchAccess, getAccessibleBranchIds } from '../../lib/branch-access.js';
import { sha256Hex } from '../../lib/hash.js';
import { nextCounterValue } from '../../lib/id-counter.js';
import { manilaDateKey, manilaDateStringToUtc } from '../../lib/manila-time.js';
import { branchShiftLockId, hashToLockId, inventoryStockLockId } from '../../lib/pg-lock.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { generateCsv } from '../../lib/reports/csv.js';
import { exportCoverage } from '../../lib/reports/export-coverage.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { auditOutboxRepository } from '../audit-outbox/audit-outbox.repository.js';
import { branchesRepository } from '../branches/branches.repository.js';
import { convertQuantity, UnitConversionError } from '../product-components/unit-conversion.util.js';
import { universalInventoryRepository } from '../universal-inventory/universal-inventory.repository.js';
import { notifyIfLowStock } from '../universal-inventory/universal-inventory.service.js';
import type { ReportColumn } from '../reports/reports.types.js';
import { extraSuppliesRepository as repo, type ExtraSupplyIssueRow, type ExtraSupplyRow } from './extra-supplies.repository.js';
import { EXTRA_SUPPLY_MOVEMENT_REFERENCE } from '../universal-inventory/universal-inventory.types.js';
import { ExtraSupplyError, type CostSource, type IssueFilters } from './extra-supplies.types.js';

type ActorContext = { id: string; role: string };
type Client = Prisma.TransactionClient;
type CreateIssueInput = Omit<z.output<typeof createExtraSupplyIssueSchema>, 'reason' | 'order_reference' | 'payment_reference'> & { reason?: string; order_reference?: string; payment_reference?: string };

// The existing product-images bucket, so no hosted bucket has to be created to ship this.
const IMAGE_BUCKET = 'product-images';
const IMAGE_URL_TTL_SECONDS = 60 * 60;
const EXPORT_ROW_LIMIT = 10_000;

const nameTaken = (name: string) => new ExtraSupplyError('EXTRA_SUPPLY_NAME_TAKEN', `An active supply named "${name}" already exists at one of these branches.`, 409);
const conflict = () => new ExtraSupplyError('EXTRA_SUPPLY_CONFLICT', 'This supply was changed by someone else since you loaded it. Reload to see the latest version before saving again.', 409);
const notFound = () => new ExtraSupplyError('EXTRA_SUPPLY_NOT_FOUND', 'Supply not found', 404);

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function imageKey(extraSupplyId: string): string {
  return `extra-supplies/${extraSupplyId}/${randomUUID()}.webp`;
}

/** Never throws: a failed signing shows the placeholder, and a card or history row still works without its picture. */
async function signImages(paths: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return new Map();
  try {
    const { data, error } = await supabaseAdmin.storage.from(IMAGE_BUCKET).createSignedUrls(unique, IMAGE_URL_TTL_SECONDS);
    if (error || !data) return new Map();
    return new Map(data.flatMap((entry) => (entry.path && entry.signedUrl ? [[entry.path, entry.signedUrl] as const] : [])));
  } catch (error) {
    console.error('Extra supply image signing failed', { errorCategory: error instanceof Error ? error.name : 'UnknownError' });
    return new Map();
  }
}

function toResponse(row: ExtraSupplyRow, liveBranchIds: 'all' | string[], issueCount: number, role: string, imageUrl: string | null): ExtraSupplyResponse {
  const visible = row.branches.filter((b) => liveBranchIds === 'all' || liveBranchIds.includes(b.branchId));
  return {
    id: row.id,
    name: row.name,
    image_url: imageUrl,
    inventory_item_id: row.inventoryItemId,
    inventory_item_name: row.inventoryItem.name,
    inventory_item_available: !row.inventoryItem.deletedAt && row.inventoryItem.trackInventory && row.inventoryItem.baseUnitId === row.baseUnitId,
    issue_unit_name: row.issueUnitName,
    entered_quantity: row.enteredQuantity.toNumber(),
    entered_unit_id: row.enteredUnitId,
    entered_unit_code: row.enteredUnit.code,
    base_quantity: row.baseQuantity.toNumber(),
    base_unit_code: row.baseUnit.code,
    configured_issue_cost: row.configuredIssueCost?.toNumber() ?? null,
    selling_price: row.sellingPrice?.toNumber() ?? null,
    apply_to_pos: row.applyToPos,
    is_active: row.isActive,
    version: row.version,
    branches: visible.map((b) => ({ branch_id: b.branchId, branch_name: b.branch.name })).sort((a, b) => a.branch_name.localeCompare(b.branch_name)),
    other_branch_count: row.branches.length - visible.length,
    can_manage: role === ROLES.SUPERVISOR && row.branches.length > 0 && row.branches.length === visible.length,
    issue_count: issueCount,
  };
}

async function responseFor(row: ExtraSupplyRow, liveBranchIds: 'all' | string[], role: string): Promise<ExtraSupplyResponse> {
  const [counts, images] = await Promise.all([repo.countIssuesBySupply([row.id], liveBranchIds), signImages(row.imagePath ? [row.imagePath] : [])]);
  return toResponse(row, liveBranchIds, counts.get(row.id) ?? 0, role, row.imagePath ? (images.get(row.imagePath) ?? null) : null);
}

function auditState(row: ExtraSupplyRow) {
  return {
    name: row.name,
    inventory_item_id: row.inventoryItemId,
    issue_unit_name: row.issueUnitName,
    entered_quantity: row.enteredQuantity.toNumber(),
    entered_unit_id: row.enteredUnitId,
    base_quantity: row.baseQuantity.toNumber(),
    base_unit_id: row.baseUnitId,
    configured_issue_cost: row.configuredIssueCost?.toNumber() ?? null,
    selling_price: row.sellingPrice?.toNumber() ?? null,
    apply_to_pos: row.applyToPos,
    is_active: row.isActive,
    has_image: row.imagePath !== null,
    branch_ids: row.branches.map((b) => b.branchId).sort(),
    version: row.version,
  };
}

/** Overlap lets a supervisor see a card; only covering its whole scope lets them change it. Assignments are read live, as for an expense type. */
async function loadManageable(id: string, actor: ActorContext, client?: Client) {
  const row = await repo.findById(id, client);
  if (!row) throw notFound();
  const liveBranchIds = await branchesRepository.findAllActiveBranchIds(actor.id, client);
  if (!row.branches.some((b) => liveBranchIds.includes(b.branchId))) throw notFound();
  if (!row.branches.every((b) => liveBranchIds.includes(b.branchId))) {
    throw new ExtraSupplyError('EXTRA_SUPPLY_SCOPE_FORBIDDEN', 'This supply is shared with a branch outside your assignment, so you can see it but not change it.', 403);
  }
  return { row, liveBranchIds };
}

async function assertBranchesAssignable(branchIds: string[], liveBranchIds: string[], client: Client): Promise<void> {
  const active = await repo.findActiveBranchIds(branchIds, client);
  if (active.length !== branchIds.length) {
    throw new ExtraSupplyError('BRANCH_SELECTION_INVALID', 'One or more selected branches do not exist or are inactive', 422);
  }
  if (!branchIds.every((id) => liveBranchIds.includes(id))) {
    throw new ExtraSupplyError('BRANCH_ACCESS_DENIED', 'You do not have an active assignment to every selected branch', 403);
  }
}

/**
 * The server-side conversion check. Same-unit is a copy; anything else needs a
 * conversion row that already exists, and none is ever guessed. A result finer than
 * the stock column's three decimals is refused rather than rounded, so what the
 * supervisor reviewed is exactly what every issue deducts.
 */
async function resolveConversion(inventoryItemId: string, enteredQuantity: number, enteredUnitId: string, client?: Client) {
  const item = await repo.findItemForConfig(inventoryItemId, client);
  if (!item || item.deletedAt) throw new ExtraSupplyError('INVENTORY_ITEM_NOT_FOUND', 'Choose an existing inventory item', 422);
  if (!item.trackInventory) throw new ExtraSupplyError('INVENTORY_ITEM_NOT_TRACKED', `${item.name} does not track stock, so a supply can't deduct from it`, 422);
  const unit = await repo.findActiveUnit(enteredUnitId, client);
  if (!unit) throw new ExtraSupplyError('UNIT_NOT_FOUND', 'Choose an active unit', 422);

  let converted: Prisma.Decimal;
  try {
    converted = await convertQuantity(enteredQuantity, enteredUnitId, item.baseUnitId, item.id);
  } catch (error) {
    if (error instanceof UnitConversionError) {
      throw new ExtraSupplyError('EXTRA_SUPPLY_NO_CONVERSION', `${item.name} is counted in ${item.baseUnit.code}, and there is no conversion from ${unit.code}. Use ${item.baseUnit.code}, or add the conversion first.`, 422);
    }
    throw error;
  }
  if (converted.lte(0) || converted.decimalPlaces() > 3) {
    throw new ExtraSupplyError('EXTRA_SUPPLY_QUANTITY_PRECISION', `${enteredQuantity} ${unit.code} is ${converted.toString()} ${item.baseUnit.code}, finer than stock can record (3 decimal places). Enter a quantity that converts exactly.`, 422);
  }
  return { item, unit, baseQuantity: converted };
}

function requestHash(data: CreateIssueInput, branchId: string): string {
  const lines = [...data.lines].sort((a, b) => a.extra_supply_id.localeCompare(b.extra_supply_id)).map((line) => [line.extra_supply_id, line.quantity, line.version]);
  const fields = [branchId, data.kind, lines, data.reason ?? null, data.order_reference ?? null, data.payment_method ?? null, data.cash_tendered ?? null, data.payment_reference ?? null, data.payment_proof_key ?? null, data.payment_proof_type ?? null];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function operationLockId(operationId: string): bigint {
  return hashToLockId(sha256Hex(`extra-supply-operation:${operationId}`));
}

function toLineResponse(line: ExtraSupplyIssueRow['lines'][number]) {
  return {
    id: line.id,
    extra_supply_id: line.extraSupplyId,
    supply_name: line.supplyName,
    current_supply_name: line.supply.name,
    issue_unit_name: line.issueUnitName,
    quantity: line.quantity,
    inventory_item_id: line.inventoryItemId,
    inventory_item_name: line.inventoryItemName,
    base_unit_code: line.baseUnitCode,
    base_quantity_each: line.baseQuantityEach.toNumber(),
    base_quantity_total: line.baseQuantityTotal.toNumber(),
    unit_price: line.unitPrice?.toNumber() ?? null,
    line_amount: line.lineAmount.toNumber(),
    cost_source: line.costSource as CostSource,
    unit_cost: line.unitCost?.toNumber() ?? null,
    line_cost: line.lineCost?.toNumber() ?? null,
  };
}

function toIssueResponse(row: ExtraSupplyIssueRow, replayed?: boolean) {
  return {
    id: row.id,
    reference_number: row.referenceNumber,
    branch_id: row.branchId,
    branch_name: row.branch.name,
    shift_id: row.shiftId,
    cashier_id: row.cashierId,
    cashier_name: `${row.cashier.firstName} ${row.cashier.lastName}`,
    kind: row.kind,
    payment_method: row.paymentMethod,
    amount_collected: row.amountCollected.toNumber(),
    amount_tendered: row.amountTendered?.toNumber() ?? null,
    change_amount: row.changeAmount?.toNumber() ?? null,
    payment_reference: row.paymentReference,
    has_payment_proof: row.paymentProofKey !== null,
    reason: row.reason,
    order_reference: row.orderReference,
    created_at: row.createdAt.toISOString(),
    lines: row.lines.map(toLineResponse),
    ...(replayed && { replayed: true }),
  };
}

/**
 * An operation id already decided. A key only ever answers the cashier and branch it
 * was issued for, and only for the request it was issued with: anything else is
 * refused without saying what the key holds.
 */
async function replayOperation(operation: NonNullable<Awaited<ReturnType<typeof repo.findOperation>>>, branchId: string, actorId: string, hash: string, client?: Client) {
  if (operation.branchId !== branchId || operation.cashierId !== actorId) {
    throw new ExtraSupplyError('EXTRA_SUPPLY_OPERATION_CONFLICT', 'This request id cannot be used here. Start a new issue.', 409);
  }
  if (operation.status === 'abandoned') {
    throw new ExtraSupplyError('EXTRA_SUPPLY_OPERATION_ABANDONED', 'This attempt was cancelled and did not go through. Start a new issue.', 409);
  }
  if (operation.requestHash !== hash) {
    throw new ExtraSupplyError('EXTRA_SUPPLY_OPERATION_REUSED', 'This attempt was already recorded with different details. Check Extra Supplies history before issuing again.', 409);
  }
  const issue = await repo.findIssue(operation.issueId as string, client);
  if (!issue) throw new ExtraSupplyError('EXTRA_SUPPLY_OPERATION_CONFLICT', 'This request id cannot be used here. Start a new issue.', 409);
  return toIssueResponse(issue, true);
}

interface AggregatedStock {
  inventoryItemId: string;
  itemName: string;
  baseUnitId: string;
  baseUnitCode: string;
  quantity: Prisma.Decimal;
  itemUnitCost: Prisma.Decimal | null;
  supplyNames: string[];
}

/**
 * One deduction per inventory item, however many cards share it, so a shortage reads
 * the combined need. Advisory locks are taken first and in sorted order, the same key
 * and order every other stock writer uses. The update itself still checks the balance:
 * see extraSuppliesRepository.deductStock.
 */
async function deductAggregated(tx: Client, branchId: string, stocks: AggregatedStock[]) {
  const sorted = [...stocks].sort((a, b) => (a.inventoryItemId < b.inventoryItemId ? -1 : 1));
  for (const stock of sorted) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${inventoryStockLockId(branchId, stock.inventoryItemId)})`;
  }
  const results = new Map<string, { before: Prisma.Decimal; after: Prisma.Decimal; carryingCost: Prisma.Decimal | null }>();
  for (const stock of sorted) {
    const updated = await repo.deductStock(branchId, stock.inventoryItemId, stock.quantity, tx);
    if (!updated) {
      const current = await repo.findStock(branchId, stock.inventoryItemId, tx);
      const available = current ? current.quantityOnHand.minus(current.quantityReserved) : new Prisma.Decimal(0);
      throw new ExtraSupplyError(
        'INSUFFICIENT_STOCK',
        `Not enough ${stock.itemName}: this issue needs ${stock.quantity.toString()} ${stock.baseUnitCode}, and ${available.toString()} ${stock.baseUnitCode} is available. Stock reserved for pending sales can't be used.`,
        409,
        { inventory_item_id: stock.inventoryItemId, needed: stock.quantity.toNumber(), available: available.toNumber() },
      );
    }
    const after = new Prisma.Decimal(updated.quantity_on_hand);
    results.set(stock.inventoryItemId, {
      before: after.plus(stock.quantity),
      after,
      carryingCost: updated.unit_cost === null ? stock.itemUnitCost : new Prisma.Decimal(updated.unit_cost),
    });
  }
  return { sorted, results };
}

function resolveCost(carryingCost: Prisma.Decimal | null, baseQuantityEach: Prisma.Decimal, configured: Prisma.Decimal | null): { source: CostSource; unitCost: Prisma.Decimal | null } {
  if (carryingCost !== null) return { source: 'inventory', unitCost: carryingCost.mul(baseQuantityEach).toDecimalPlaces(4) };
  if (configured !== null) return { source: 'configured', unitCost: configured };
  return { source: 'unknown', unitCost: null };
}

function toFilters(query: ExtraSupplyIssueSummaryQuery, branchIds: 'all' | string[]): IssueFilters {
  return {
    branchIds,
    branchId: query.branch_id,
    dateFrom: query.date_from ? manilaDateStringToUtc(query.date_from) : undefined,
    // Exclusive: the start of the Manila day after date_to.
    dateTo: query.date_to ? new Date(manilaDateStringToUtc(query.date_to).getTime() + 24 * 60 * 60 * 1000) : undefined,
    extraSupplyId: query.extra_supply_id,
    kind: query.kind,
    cashierId: query.cashier_id,
  };
}

/** A branch filter outside the caller's scope is refused, never quietly widened or emptied. */
async function resolveScope(actor: JwtPayload, branchId: string | undefined) {
  if (branchId) await assertBranchAccess(actor, branchId, ExtraSupplyError);
  return getAccessibleBranchIds(actor);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function emptyCostFields() {
  return { units_free: 0, units_paid: 0, amount_collected: 0, inventory_cost: 0, configured_cost: 0, unknown_cost_lines: 0 };
}

type CostFields = ReturnType<typeof emptyCostFields>;
type LineGroup = Awaited<ReturnType<typeof repo.groupLines>>[number];

function addGroup(target: CostFields, group: LineGroup): void {
  const quantity = group._sum.quantity ?? 0;
  if (group.kind === 'free') target.units_free += quantity;
  else target.units_paid += quantity;
  target.amount_collected = round2(target.amount_collected + (group._sum.lineAmount?.toNumber() ?? 0));
  const cost = group._sum.lineCost?.toNumber() ?? 0;
  if (group.costSource === 'inventory') target.inventory_cost = round2(target.inventory_cost + cost);
  else if (group.costSource === 'configured') target.configured_cost = round2(target.configured_cost + cost);
  else target.unknown_cost_lines += group._count._all;
}

export const extraSuppliesService = {
  async list(user: JwtPayload, filters: ExtraSupplyListQuery) {
    const accessible = await resolveScope(user, filters.branch_id);
    const rows = await repo.findMany({
      includeInactive: filters.include_inactive,
      ...(filters.branch_id ? { branchIds: [filters.branch_id] } : accessible !== 'all' ? { branchIds: accessible } : {}),
    });
    const [counts, images] = await Promise.all([
      repo.countIssuesBySupply(rows.map((row) => row.id), accessible),
      signImages(rows.flatMap((row) => (row.imagePath ? [row.imagePath] : []))),
    ]);
    return { supplies: rows.map((row) => toResponse(row, accessible, counts.get(row.id) ?? 0, user.role, row.imagePath ? (images.get(row.imagePath) ?? null) : null)) };
  },

  /** What a save would store, shown to the supervisor before they commit to it. */
  async previewConversion(inventoryItemId: string, enteredQuantity: number, enteredUnitId: string) {
    const { item, unit, baseQuantity } = await resolveConversion(inventoryItemId, enteredQuantity, enteredUnitId);
    return { inventory_item_name: item.name, base_quantity: baseQuantity.toNumber(), base_unit_code: item.baseUnit.code, entered_unit_code: unit.code, item_unit_cost: item.unitCost?.toNumber() ?? null };
  },

  async create(data: CreateExtraSupplyInput, actor: ActorContext, ipAddress: string | null) {
    const branchIds = [...new Set(data.branch_ids)];
    let saved;
    try {
      saved = await repo.transaction(async (tx) => {
        const liveBranchIds = await branchesRepository.findAllActiveBranchIds(actor.id, tx);
        await assertBranchesAssignable(branchIds, liveBranchIds, tx);
        const { item, baseQuantity } = await resolveConversion(data.inventory_item_id, data.entered_quantity, data.entered_unit_id, tx);
        const row = await repo.create(
          {
            name: data.name,
            normalizedName: normalizeExtraSupplyName(data.name),
            inventoryItemId: item.id,
            issueUnitName: data.issue_unit_name,
            enteredQuantity: data.entered_quantity,
            enteredUnitId: data.entered_unit_id,
            baseQuantity: baseQuantity.toString(),
            baseUnitId: item.baseUnitId,
            configuredIssueCost: data.configured_issue_cost ?? null,
            sellingPrice: data.selling_price ?? null,
            applyToPos: data.apply_to_pos,
            createdById: actor.id,
          },
          branchIds,
          tx,
        );
        return { row, liveBranchIds };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken(data.name);
      throw error;
    }

    await recordAuditLog({ action: 'EXTRA_SUPPLY_CREATED', entityType: 'extra_supply', entityId: saved.row.id, actorId: actor.id, actorRole: actor.role, afterState: auditState(saved.row), ipAddress });
    return responseFor(saved.row, saved.liveBranchIds, actor.role);
  },

  /**
   * Branches can always be added. A branch can be removed only while it has never
   * issued this card, so a scope edit can't hide history. The check runs after this
   * transaction holds the card's row, and an issue takes the same row (lockForIssue),
   * so neither can slip past the other.
   */
  async update(id: string, data: UpdateExtraSupplyInput, actor: ActorContext, ipAddress: string | null) {
    let saved;
    try {
      saved = await repo.transaction(async (tx) => {
        const { row: before, liveBranchIds } = await loadManageable(id, actor, tx);
        const conversionChanged = data.inventory_item_id !== undefined || data.entered_quantity !== undefined || data.entered_unit_id !== undefined;
        const conversion = conversionChanged
          ? await resolveConversion(data.inventory_item_id ?? before.inventoryItemId, data.entered_quantity ?? before.enteredQuantity.toNumber(), data.entered_unit_id ?? before.enteredUnitId, tx)
          : null;

        const swapped = await repo.compareAndUpdate(
          id,
          {
            ...(data.name !== undefined && { name: data.name, normalizedName: normalizeExtraSupplyName(data.name) }),
            ...(data.issue_unit_name !== undefined && { issueUnitName: data.issue_unit_name }),
            ...(conversion && {
              inventoryItemId: conversion.item.id,
              enteredQuantity: data.entered_quantity ?? before.enteredQuantity.toNumber(),
              enteredUnitId: data.entered_unit_id ?? before.enteredUnitId,
              baseQuantity: conversion.baseQuantity.toString(),
              baseUnitId: conversion.item.baseUnitId,
            }),
            ...(data.configured_issue_cost !== undefined && { configuredIssueCost: data.configured_issue_cost }),
            ...(data.selling_price !== undefined && { sellingPrice: data.selling_price }),
            ...(data.apply_to_pos !== undefined && { applyToPos: data.apply_to_pos }),
            updatedById: actor.id,
          },
          data.expected_version,
          tx,
        );
        if (!swapped) throw conflict();

        const current = before.branches.map((b) => b.branchId);
        const next = data.branch_ids ? [...new Set(data.branch_ids)] : current;
        const added = next.filter((branchId) => !current.includes(branchId));
        const removed = current.filter((branchId) => !next.includes(branchId));
        if (added.length > 0) await assertBranchesAssignable(added, liveBranchIds, tx);
        if (removed.length > 0) {
          const inUse = await repo.branchesWithIssues(id, removed, tx);
          if (inUse.length > 0) {
            const names = before.branches.filter((b) => inUse.some((use) => use.branchId === b.branchId)).map((b) => b.branch.name);
            throw new ExtraSupplyError('EXTRA_SUPPLY_SCOPE_IN_USE', `${names.join(', ')} already issued this supply, so it can't be removed. Deactivate the supply or create a new one for a smaller set of branches.`, 422);
          }
        }
        await repo.replaceScope(id, added, removed, tx);
        const row = await repo.findById(id, tx);
        return { before, row: row as ExtraSupplyRow, liveBranchIds };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken(data.name ?? 'this name');
      throw error;
    }

    await recordAuditLog({ action: 'EXTRA_SUPPLY_UPDATED', entityType: 'extra_supply', entityId: id, actorId: actor.id, actorRole: actor.role, beforeState: auditState(saved.before), afterState: auditState(saved.row), ipAddress });
    return responseFor(saved.row, saved.liveBranchIds, actor.role);
  },

  /** Stops new use and nothing else. Reactivating refuses a name another active card now holds. */
  async setActive(id: string, isActive: boolean, expectedVersion: number, actor: ActorContext, ipAddress: string | null) {
    const { row: before, liveBranchIds } = await loadManageable(id, actor);
    // A retry of a change that already happened.
    if (before.isActive === isActive) return responseFor(before, liveBranchIds, actor.role);

    let row;
    try {
      row = await repo.setActive(id, isActive, expectedVersion, actor.id);
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken(before.name);
      throw error;
    }
    if (!row) throw conflict();

    await recordAuditLog({
      action: isActive ? 'EXTRA_SUPPLY_REACTIVATED' : 'EXTRA_SUPPLY_DEACTIVATED',
      entityType: 'extra_supply',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      beforeState: { is_active: before.isActive },
      afterState: { is_active: row.isActive },
      ipAddress,
    });
    return responseFor(row, liveBranchIds, actor.role);
  },

  /**
   * The new object goes to its own path first and the card is updated after, so a
   * failed upload or a stale version leaves the old picture and its history as they
   * were. The old object is removed last, best effort: a leftover file is harmless,
   * and a missing picture on a live card isn't.
   */
  async uploadImage(id: string, file: { buffer: Buffer }, expectedVersion: number, actor: ActorContext, ipAddress: string | null) {
    const { row: before, liveBranchIds } = await loadManageable(id, actor);
    if (before.version !== expectedVersion) throw conflict();

    let compressed: Buffer;
    try {
      compressed = await sharp(file.buffer).resize({ width: 800, withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
    } catch {
      throw new ExtraSupplyError('INVALID_IMAGE', 'This file could not be read as an image', 422);
    }

    const path = imageKey(id);
    const { error } = await supabaseAdmin.storage.from(IMAGE_BUCKET).upload(path, compressed, { contentType: 'image/webp', upsert: false, cacheControl: String(IMAGE_URL_TTL_SECONDS) });
    if (error) {
      console.error('Extra supply image upload failed', { errorName: error.name, errorMessage: error.message });
      throw new ExtraSupplyError('EXTRA_SUPPLY_IMAGE_UPLOAD_FAILED', 'The image could not be uploaded. The current image and all other details are unchanged.', 502);
    }

    const saved = await repo.compareAndSetImage(id, path, expectedVersion, actor.id);
    if (!saved) {
      await removeObject(path);
      throw conflict();
    }
    if (before.imagePath) await removeObject(before.imagePath);

    await recordAuditLog({ action: 'EXTRA_SUPPLY_IMAGE_CHANGED', entityType: 'extra_supply', entityId: id, actorId: actor.id, actorRole: actor.role, beforeState: { image_path: before.imagePath }, afterState: { image_path: path }, ipAddress });
    const row = await repo.findById(id);
    return responseFor(row as ExtraSupplyRow, liveBranchIds, actor.role);
  },

  async removeImage(id: string, expectedVersion: number, actor: ActorContext, ipAddress: string | null) {
    const { row: before, liveBranchIds } = await loadManageable(id, actor);
    if (!before.imagePath) return responseFor(before, liveBranchIds, actor.role);
    const saved = await repo.compareAndSetImage(id, null, expectedVersion, actor.id);
    if (!saved) throw conflict();
    await removeObject(before.imagePath);
    await recordAuditLog({ action: 'EXTRA_SUPPLY_IMAGE_CHANGED', entityType: 'extra_supply', entityId: id, actorId: actor.id, actorRole: actor.role, beforeState: { image_path: before.imagePath }, afterState: { image_path: null }, ipAddress });
    const row = await repo.findById(id);
    return responseFor(row as ExtraSupplyRow, liveBranchIds, actor.role);
  },

  /** Active cards applied to the POS at this branch, with what stock covers right now. Only a guide: the issue checks again. */
  async terminalCards(user: JwtPayload, branchId: string) {
    await assertBranchAccess(user, branchId, ExtraSupplyError);
    const rows = await repo.terminalCards(branchId);
    const usable = rows.filter((row) => row.inventoryItem.baseUnitId === row.baseUnitId);
    const [stocks, images] = await Promise.all([
      repo.findStocks(branchId, [...new Set(usable.map((row) => row.inventoryItemId))]),
      signImages(usable.flatMap((row) => (row.imagePath ? [row.imagePath] : []))),
    ]);
    const stockByItem = new Map(stocks.map((stock) => [stock.inventoryItemId, stock]));
    return {
      cards: usable.map((row) => {
        const stock = stockByItem.get(row.inventoryItemId);
        const available = stock ? stock.quantityOnHand.minus(stock.quantityReserved).toNumber() : 0;
        const base = row.baseQuantity.toNumber();
        return {
          id: row.id,
          name: row.name,
          image_url: row.imagePath ? (images.get(row.imagePath) ?? null) : null,
          issue_unit_name: row.issueUnitName,
          inventory_item_id: row.inventoryItemId,
          inventory_item_name: row.inventoryItem.name,
          base_quantity: base,
          base_unit_code: row.baseUnit.code,
          selling_price: row.sellingPrice?.toNumber() ?? null,
          version: row.version,
          available_base_quantity: available,
          available_issue_quantity: availableIssueQuantity(available, base),
        };
      }),
    };
  },

  /**
   * Posts one issue. Issue, lines, stock deduction, movements, operation row and audit
   * intent commit together, or nothing does. branchId, shiftId and actor come from the
   * authenticated session, never the request body.
   *
   * Lock order: operation, shift (shared), card rows, stock. A refund takes shift then
   * stock too, and a shift close takes the shift lock alone. Shared here so issues don't
   * wait for each other, only for a close, whose expected cash must include or exclude
   * this issue outright.
   */
  async createIssue(data: CreateIssueInput, branchId: string, shiftId: string | undefined, actor: ActorContext, ipAddress: string | null) {
    const hash = requestHash(data, branchId);

    // The usual retry: answered before anything else is reserved or locked.
    const prior = await repo.findOperation(data.operation_id);
    if (prior) return replayOperation(prior, branchId, actor.id, hash);

    if (!shiftId) throw new ExtraSupplyError('SHIFT_REQUIRED', 'An open shift is required to issue supplies', 409);
    const branch = await branchesRepository.findById(branchId);
    if (!branch) throw new ExtraSupplyError('BRANCH_NOT_FOUND', 'Branch not found', 404);
    const prefix = `ES-${branch.code}-${manilaDateKey(new Date()).replaceAll('-', '')}-`;
    const referenceNumber = `${prefix}${String(await nextCounterValue(`extra_supply_counter:${prefix}`)).padStart(6, '0')}`;
    const issueId = randomUUID();
    const createdAt = new Date();

    const outcome = await repo.transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${operationLockId(data.operation_id)})`;
        const raced = await repo.findOperation(data.operation_id, tx);
        if (raced) return { replay: await replayOperation(raced, branchId, actor.id, hash, tx), sorted: [] };

        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${branchShiftLockId(branchId)})`;
        const shift = await tx.shift.findUnique({ where: { id: shiftId }, select: { status: true, branchId: true } });
        if (!shift || shift.branchId !== branchId || shift.status !== 'active') {
          throw new ExtraSupplyError('SHIFT_CLOSED', 'This shift is closed. Clock in again before issuing supplies.', 409);
        }

        const supplyIds = data.lines.map((line) => line.extra_supply_id);
        const supplies = await repo.lockForIssue(supplyIds, tx);
        const supplyById = new Map(supplies.map((supply) => [supply.id, supply]));

        const aggregated = new Map<string, AggregatedStock>();
        let amountCents = 0;
        const resolved = data.lines.map((line) => {
          const supply = supplyById.get(line.extra_supply_id);
          // Absent and out-of-scope read the same, so a foreign id learns nothing.
          if (!supply || !supply.branches.some((b) => b.branchId === branchId) || !supply.isActive || !supply.applyToPos) {
            throw new ExtraSupplyError('EXTRA_SUPPLY_UNAVAILABLE', `${supply && supply.branches.some((b) => b.branchId === branchId) ? supply.name : 'A selected supply'} can no longer be issued here. Reload and review your selection.`, 409);
          }
          if (supply.version !== line.version) {
            throw new ExtraSupplyError('EXTRA_SUPPLY_CONFIG_STALE', `${supply.name} was changed after you selected it. Review the updated details and confirm again.`, 409, { extra_supply_id: supply.id });
          }
          if (supply.inventoryItem.deletedAt || !supply.inventoryItem.trackInventory || supply.inventoryItem.baseUnitId !== supply.baseUnitId) {
            throw new ExtraSupplyError('EXTRA_SUPPLY_INVENTORY_UNAVAILABLE', `${supply.name}'s inventory item changed and needs a supervisor to review it before it can be issued.`, 409);
          }
          if (data.kind === 'paid' && supply.sellingPrice === null) {
            throw new ExtraSupplyError('EXTRA_SUPPLY_NOT_FOR_SALE', `${supply.name} has no selling price, so it can only be given free.`, 422);
          }
          const lineCents = data.kind === 'paid' ? Math.round((supply.sellingPrice as Prisma.Decimal).toNumber() * 100) * line.quantity : 0;
          amountCents += lineCents;

          const baseTotal = supply.baseQuantity.mul(line.quantity);
          const existing = aggregated.get(supply.inventoryItemId);
          if (existing) {
            existing.quantity = existing.quantity.plus(baseTotal);
            existing.supplyNames.push(supply.name);
          } else {
            aggregated.set(supply.inventoryItemId, {
              inventoryItemId: supply.inventoryItemId,
              itemName: supply.inventoryItem.name,
              baseUnitId: supply.baseUnitId,
              baseUnitCode: supply.baseUnit.code,
              quantity: baseTotal,
              itemUnitCost: supply.inventoryItem.unitCost,
              supplyNames: [supply.name],
            });
          }
          return { line, supply, baseTotal, lineCents };
        });

        const amount = amountCents / 100;
        const tendered = data.kind === 'paid' && data.payment_method === 'cash' ? (data.cash_tendered as number) : null;
        if (tendered !== null && Math.round(tendered * 100) < amountCents) {
          throw new ExtraSupplyError('INSUFFICIENT_CASH_TENDERED', `Cash received (${tendered}) is less than the amount to collect (${amount})`, 422);
        }
        const isNonCash = data.kind === 'paid' && data.payment_method !== 'cash';
        if (isNonCash) {
          // Proof keys are built as <branch>/<shift>/<actor>-..., so a key from another branch or cashier is refused.
          const [keyBranch, , keyFile] = (data.payment_proof_key as string).split('/');
          if (keyBranch !== branchId || !keyFile?.startsWith(`${actor.id}-`)) {
            throw new ExtraSupplyError('PAYMENT_PROOF_INVALID', 'That payment proof was not uploaded for this issue. Upload it again.', 422);
          }
        }

        const { sorted, results } = await deductAggregated(tx, branchId, [...aggregated.values()]);

        const lines = resolved.map(({ line, supply, baseTotal, lineCents }) => {
          const carryingCost = results.get(supply.inventoryItemId)?.carryingCost ?? null;
          const { source, unitCost } = resolveCost(carryingCost, supply.baseQuantity, supply.configuredIssueCost);
          return {
            id: randomUUID(),
            issueId,
            extraSupplyId: supply.id,
            supplyName: supply.name,
            supplyVersion: supply.version,
            issueUnitName: supply.issueUnitName,
            quantity: line.quantity,
            inventoryItemId: supply.inventoryItemId,
            inventoryItemName: supply.inventoryItem.name,
            baseUnitCode: supply.baseUnit.code,
            baseQuantityEach: supply.baseQuantity,
            baseQuantityTotal: baseTotal,
            unitPrice: data.kind === 'paid' ? supply.sellingPrice : null,
            lineAmount: lineCents / 100,
            costSource: source,
            unitCost,
            lineCost: unitCost ? unitCost.mul(line.quantity).toDecimalPlaces(4) : null,
            branchId,
            kind: data.kind,
            paymentMethod: data.kind === 'paid' ? data.payment_method : null,
            cashierId: actor.id,
            createdAt,
          };
        });

        await repo.createIssue(
          {
            id: issueId,
            referenceNumber,
            branchId,
            shiftId,
            cashierId: actor.id,
            kind: data.kind,
            paymentMethod: data.kind === 'paid' ? data.payment_method : null,
            amountCollected: amount,
            amountTendered: tendered,
            changeAmount: tendered !== null ? (Math.round(tendered * 100) - amountCents) / 100 : null,
            paymentReference: data.payment_reference ?? null,
            paymentProofKey: isNonCash ? (data.payment_proof_key as string) : null,
            paymentProofType: isNonCash ? (data.payment_proof_type ?? null) : null,
            reason: data.reason ?? null,
            orderReference: data.order_reference ?? null,
            createdAt,
          },
          lines,
          { id: data.operation_id, requestHash: hash },
          tx,
        );

        for (const stock of sorted) {
          const result = results.get(stock.inventoryItemId);
          if (!result) continue;
          // Only the inventory's own cost reaches the movement ledger, which feeds
          // inventory value. A configured cost stays on the issue line.
          await universalInventoryRepository.createStockMovement(
            {
              branchId,
              inventoryItemId: stock.inventoryItemId,
              movementType: 'ADJUSTMENT_OUT',
              quantityChange: stock.quantity.negated(),
              quantityBefore: result.before,
              quantityAfter: result.after,
              unitId: stock.baseUnitId,
              referenceType: EXTRA_SUPPLY_MOVEMENT_REFERENCE,
              referenceId: issueId,
              notes: `Extra supply issue ${referenceNumber}: ${stock.supplyNames.join(', ')}`,
              performedByUserId: actor.id,
              responsibleUserId: actor.id,
              unitCost: result.carryingCost ?? undefined,
              totalCost: result.carryingCost ? result.carryingCost.mul(stock.quantity).toDecimalPlaces(4) : undefined,
            },
            tx,
          );
        }

        await auditOutboxRepository.enqueue(tx, [
          {
            action: 'EXTRA_SUPPLY_ISSUED',
            entityType: 'extra_supply_issue',
            entityId: issueId,
            actorId: actor.id,
            actorRole: actor.role,
            branchId,
            afterState: { reference_number: referenceNumber, kind: data.kind, payment_method: data.payment_method ?? null, amount_collected: amount, lines: data.lines },
            ipAddress,
          },
        ]);

        return { replay: null, sorted };
      },
      // Same reasoning as checkout: several statements against a remote pooled database.
      { maxWait: config.posTransaction.maxWaitMs, timeout: config.posTransaction.timeoutMs },
    );

    if (outcome.replay) return outcome.replay;

    // After commit, so a failed notification can't undo or misreport a posted issue.
    for (const stock of outcome.sorted) {
      try {
        const current = await universalInventoryRepository.findStock(branchId, stock.inventoryItemId);
        await notifyIfLowStock({
          branchId,
          inventoryItemId: stock.inventoryItemId,
          itemName: stock.itemName,
          quantityAfter: current?.quantityOnHand.toNumber() ?? 0,
          lowStockThreshold: current?.lowStockThreshold?.toNumber() ?? null,
          criticalThreshold: current?.criticalThreshold?.toNumber() ?? null,
        });
      } catch (error) {
        console.error('Extra supply low-stock notification failed', { branchId, errorCategory: error instanceof Error ? error.name : 'UnknownError' });
      }
    }

    const issue = await repo.findIssue(issueId);
    return toIssueResponse(issue as ExtraSupplyIssueRow);
  },

  /** How a client resolves a reply it never received. Answers only the cashier who owns the id. */
  async getOperation(operationId: string, actor: ActorContext) {
    const operation = await repo.findOperation(operationId);
    if (!operation || operation.cashierId !== actor.id) return { status: 'not_found' as const };
    if (operation.status === 'abandoned') return { status: 'abandoned' as const };
    const issue = await repo.findIssue(operation.issueId as string);
    if (!issue) return { status: 'not_found' as const };
    return { status: 'committed' as const, issue: toIssueResponse(issue) };
  },

  /**
   * Gives up on an id only after fencing it: a delayed original arriving later is
   * refused. Holds the same lock as createIssue, so if the original is mid-commit this
   * waits for it and reports the issue instead of cancelling.
   */
  async abandonOperation(operationId: string, branchId: string, actor: ActorContext) {
    return repo.transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${operationLockId(operationId)})`;
      const existing = await repo.findOperation(operationId, tx);
      if (!existing) {
        await repo.createAbandonedOperation(operationId, branchId, actor.id, tx);
        return { status: 'abandoned' as const };
      }
      if (existing.branchId !== branchId || existing.cashierId !== actor.id) {
        throw new ExtraSupplyError('EXTRA_SUPPLY_OPERATION_CONFLICT', 'This request id cannot be used here.', 409);
      }
      if (existing.status === 'abandoned') return { status: 'abandoned' as const };
      const issue = await repo.findIssue(existing.issueId as string, tx);
      return { status: 'committed' as const, issue: toIssueResponse(issue as ExtraSupplyIssueRow) };
    });
  },

  async listIssues(user: JwtPayload, query: ExtraSupplyIssueListQuery) {
    const branchIds = await resolveScope(user, query.branch_id);
    const { issues, total } = await repo.findIssues(toFilters(query, branchIds), query.page, query.limit);
    return { issues: issues.map((issue) => toIssueResponse(issue)), total, page: query.page, limit: query.limit };
  },

  /** Out of scope reads as absent, as for an expense type. */
  async getIssue(user: JwtPayload, id: string) {
    const issue = await repo.findIssue(id);
    const branchIds = await getAccessibleBranchIds(user);
    if (!issue || (branchIds !== 'all' && !branchIds.includes(issue.branchId))) {
      throw new ExtraSupplyError('EXTRA_SUPPLY_ISSUE_NOT_FOUND', 'Issue not found', 404);
    }
    const movements = await repo.findMovements(id);
    return {
      ...toIssueResponse(issue),
      movements: movements.map((movement) => ({
        id: movement.id,
        inventory_item_id: movement.inventoryItemId,
        inventory_item_name: movement.inventoryItem.name,
        quantity_change: movement.quantityChange.toNumber(),
        quantity_before: movement.quantityBefore.toNumber(),
        quantity_after: movement.quantityAfter.toNumber(),
        unit_code: movement.unit?.code ?? null,
        created_at: movement.createdAt.toISOString(),
      })),
    };
  },

  /** Every figure is over the whole filtered period, grouped from the same lines the history lists. */
  async getSummary(user: JwtPayload, query: ExtraSupplyIssueSummaryQuery): Promise<ExtraSupplySummaryResponse> {
    const branchIds = await resolveScope(user, query.branch_id);
    const filters = toFilters(query, branchIds);
    const productSalesApply = !query.extra_supply_id && !query.kind;
    const [groups, issueCount, productSales] = await Promise.all([repo.groupLines(filters), repo.countIssues(filters), productSalesApply ? repo.sumProductSales(filters) : Promise.resolve(null)]);
    const [branchNames, supplyNames, cashierNames] = await repo.findNames([...new Set(groups.map((g) => g.branchId))], [...new Set(groups.map((g) => g.extraSupplyId))], [...new Set(groups.map((g) => g.cashierId))]);

    const totals = emptyCostFields();
    const byBranch = new Map<string, CostFields>();
    const bySupply = new Map<string, CostFields>();
    const byCashier = new Map<string, CostFields>();
    const byMethod = new Map<string, { amount: number; line_count: number }>();
    for (const group of groups) {
      addGroup(totals, group);
      addGroup(byBranch.get(group.branchId) ?? (byBranch.set(group.branchId, emptyCostFields()).get(group.branchId) as CostFields), group);
      addGroup(bySupply.get(group.extraSupplyId) ?? (bySupply.set(group.extraSupplyId, emptyCostFields()).get(group.extraSupplyId) as CostFields), group);
      addGroup(byCashier.get(group.cashierId) ?? (byCashier.set(group.cashierId, emptyCostFields()).get(group.cashierId) as CostFields), group);
      if (group.paymentMethod) {
        const entry = byMethod.get(group.paymentMethod) ?? { amount: 0, line_count: 0 };
        entry.amount = round2(entry.amount + (group._sum.lineAmount?.toNumber() ?? 0));
        entry.line_count += group._count._all;
        byMethod.set(group.paymentMethod, entry);
      }
    }

    const productTotal = productSales?.toNumber() ?? null;
    return {
      issue_count: issueCount,
      ...totals,
      by_payment_method: [...byMethod.entries()].map(([payment_method, entry]) => ({ payment_method: payment_method as 'cash' | 'gcash' | 'maya' | 'other', ...entry })).sort((a, b) => b.amount - a.amount),
      by_branch: [...byBranch.entries()]
        .map(([branch_id, fields]) => ({ branch_id, branch_name: branchNames.find((b) => b.id === branch_id)?.name ?? 'Unknown branch', ...fields }))
        .sort((a, b) => a.branch_name.localeCompare(b.branch_name)),
      by_supply: [...bySupply.entries()]
        .map(([extra_supply_id, fields]) => ({ extra_supply_id, name: supplyNames.find((s) => s.id === extra_supply_id)?.name ?? 'Unknown supply', ...fields }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      by_cashier: [...byCashier.entries()]
        .map(([cashier_id, fields]) => {
          const cashier = cashierNames.find((c) => c.id === cashier_id);
          return { cashier_id, name: cashier ? `${cashier.firstName} ${cashier.lastName}` : 'Unknown', ...fields };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
      product_sales_total: productTotal,
      combined_collection_total: productTotal === null ? null : round2(productTotal + totals.amount_collected),
    };
  },

  /** One row per line, capped as other exports are. A cut file says so inside and in its name. */
  async exportCsv(user: JwtPayload, query: ExtraSupplyIssueSummaryQuery) {
    const branchIds = await resolveScope(user, query.branch_id);
    const rows = await repo.findLinesForExport(toFilters(query, branchIds), EXPORT_ROW_LIMIT + 1);
    const hasMore = rows.length > EXPORT_ROW_LIMIT;
    const kept = rows.slice(0, EXPORT_ROW_LIMIT);
    const coverage = exportCoverage(kept.length, hasMore, {
      noun: 'extra supply lines',
      screen: 'Extra Supplies history',
      newestAt: kept[0]?.createdAt.toISOString(),
      oldestAt: kept[kept.length - 1]?.createdAt.toISOString(),
      totals: [{ label: 'collected', amount: kept.reduce((cents, row) => cents + Math.round(row.lineAmount.toNumber() * 100), 0) / 100 }],
    });
    const data = kept.map((row) => ({
      created_at: row.createdAt.toISOString(),
      reference_number: row.issue.referenceNumber,
      branch: row.issue.branch.name,
      cashier: `${row.issue.cashier.firstName} ${row.issue.cashier.lastName}`,
      supply: row.supplyName,
      quantity: row.quantity,
      issue_unit: row.issueUnitName,
      kind: row.kind,
      unit_price: row.unitPrice?.toNumber() ?? '',
      amount_collected: row.lineAmount.toNumber(),
      payment_method: row.paymentMethod ?? '',
      inventory_item: row.inventoryItemName,
      inventory_quantity: row.baseQuantityTotal.toNumber(),
      inventory_unit: row.baseUnitCode,
      cost_source: row.costSource,
      cost: row.lineCost?.toNumber() ?? '',
      reason: row.issue.reason ?? '',
      order_reference: row.issue.orderReference ?? '',
    }));
    const columns: ReportColumn<(typeof data)[number]>[] = [
      { key: 'created_at', header: 'Issued At' },
      { key: 'reference_number', header: 'Reference' },
      { key: 'branch', header: 'Branch' },
      { key: 'cashier', header: 'Issued By' },
      { key: 'supply', header: 'Supply' },
      { key: 'quantity', header: 'Quantity' },
      { key: 'issue_unit', header: 'Unit' },
      { key: 'kind', header: 'Free or Paid' },
      { key: 'unit_price', header: 'Price Charged' },
      { key: 'amount_collected', header: 'Amount Collected' },
      { key: 'payment_method', header: 'Payment Method' },
      { key: 'inventory_item', header: 'Inventory Item' },
      { key: 'inventory_quantity', header: 'Inventory Quantity' },
      { key: 'inventory_unit', header: 'Inventory Unit' },
      { key: 'cost_source', header: 'Cost Source' },
      { key: 'cost', header: 'Cost' },
      { key: 'reason', header: 'Reason' },
      { key: 'order_reference', header: 'Order Reference (as typed)' },
    ];
    return {
      buffer: generateCsv(data, columns, coverage.note),
      filename: `extra-supplies${coverage.partial ? '-PARTIAL' : ''}-${manilaDateKey(new Date())}.csv`,
    };
  },
};

async function removeObject(path: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.storage.from(IMAGE_BUCKET).remove([path]);
    if (error) console.error('Extra supply image cleanup failed', { errorName: error.name });
  } catch (error) {
    console.error('Extra supply image cleanup failed', { errorCategory: error instanceof Error ? error.name : 'UnknownError' });
  }
}
