import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
  DISCOUNT_TYPE,
  SOCKET_EVENTS,
  MOVEMENT_TYPE,
  INVENTORY_DEDUCTION_STATUS,
  PAYMENT_METHOD,
  type ImageProofType,
} from '@potato-corner/shared';
import { manilaDateKey } from '../../lib/manila-time.js';
import { transactionsRepository, type SelectedOptionSnapshot } from './transactions.repository.js';
import {
  TransactionError,
  HOLD_ORDER_LIMIT_PER_TERMINAL,
  HOLD_ORDER_EXPIRY_MS,
  type CartItemInput,
  type CreateTransactionData,
  type CreateHoldOrderData,
  type TransactionListFilters,
  type SyncOfflineTransactionsData,
  type DiscountAuditFilters,
  type UploadPaymentProofData,
  type UploadDiscountProofData,
} from './transactions.types.js';
import { cashRepository } from '../cash/cash.repository.js';
import { inventoryRepository } from '../inventory/inventory.repository.js';
import { computeBomDeduction } from '../shadow-bom-deduction/shadow-bom-deduction.service.js';
import type { BomDeductionLine } from '../shadow-bom-deduction/shadow-bom-deduction.types.js';
import { convertQuantity, UnitConversionError } from '../product-components/unit-conversion.util.js';
// Retained solely for reverseInventoryForTransaction's fallback path, which
// replays a legacy-shaped deductionSnapshot (or, for transactions that
// predate the snapshot column entirely, recomputes from ProductInventory) —
// the only remaining live callers of the legacy deduction model.
import { computeDeduction } from '../product-inventory/product-inventory.service.js';
import { productComponentsRepository } from '../product-components/product-components.repository.js';
import { universalInventoryRepository } from '../universal-inventory/universal-inventory.repository.js';
import { productReadinessService } from '../product-readiness/product-readiness.service.js';
import type { ProductVariantReadinessResult } from '../product-readiness/product-readiness.types.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { encryptField, hashField, decryptField } from '../../lib/encryption.js';
import { hashToLockId } from '../../lib/pg-lock.js';
import { sha256Hex } from '../../lib/hash.js';
import { enqueueRawNotificationJob, enqueueNotification } from '../../queues/notification.queue.js';
import { enqueueHoldOrderExpiry } from '../../queues/hold-order.queue.js';
import { triggerFraudScanForBranch } from '../../queues/fraud.queue.js';
import { notifyBranch, notifySuperAdmin } from '../../lib/notify.js';
import { prisma } from '../../lib/prisma.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { attachCostToDeductionLines } from '../../lib/cogs.js';
import { config, isShadowBomDeductionEnabledForBranch } from '../../config/index.js';
import { shadowBomDeductionService } from '../shadow-bom-deduction/shadow-bom-deduction.service.js';

type ActorContext = { id: string; role: string };

/** Architecture doc §Discounts — PWD/Senior Citizen VAT formula (Philippine law), locked, never modified without explicit instruction. */
const STATUTORY_DISCOUNT_RATE = 0.2;
/** "Employee (configurable %)" per the architecture doc — no settings model yet, so this constant is the one a future settings feature would read from instead. */
const EMPLOYEE_DISCOUNT_RATE = 0.2;
/** How many bumped-sequence attempts before giving up on a receipt number collision (P2002 on the daily per-branch sequence). */
const RECEIPT_SEQUENCE_RETRY_LIMIT = 5;

const PAYMENT_PROOF_BUCKET = 'payment-proofs';
/** GCash, Maya, and Other all require a payment proof photo — only cash does not (Task 139). */
const PROOF_REQUIRED_METHODS: readonly string[] = [PAYMENT_METHOD.GCASH, PAYMENT_METHOD.MAYA, PAYMENT_METHOD.OTHER];

/**
 * Task 209.5 — PWD/Senior Citizen discount compliance evidence. Deliberately
 * a separate bucket from PAYMENT_PROOF_BUCKET: payment proof and discount
 * proof must never share a path prefix or be ambiguous about which evidence
 * a given object is.
 */
const DISCOUNT_PROOF_BUCKET = 'discount-proofs';
/**
 * No proof-required policy exists yet for PWD/Senior Citizen discounts (no
 * settings model wires into discount eligibility today — see
 * STATUTORY_DISCOUNT_RATE above). Proof capture stays optional until such a
 * policy is introduced; see DISCOUNT_PROOF_REQUIREMENT_POLICY_MISSING in
 * createTransaction below.
 */

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

/**
 * Fresh 60-minute signed URL, generated on demand — mirrors
 * expenses.service.ts getSignedReceiptUrl. Never cached/stored; the DB only
 * ever holds the storage key.
 */
async function getSignedPaymentProofUrl(key: string): Promise<string> {
  const { data, error } = await supabaseAdmin.storage.from(PAYMENT_PROOF_BUCKET).createSignedUrl(key, 60 * 60);
  if (error || !data) throw new TransactionError('PAYMENT_PROOF_URL_FAILED', 'Could not generate payment proof URL', 500);
  return data.signedUrl;
}

/** Same fresh-signed-URL rule as getSignedPaymentProofUrl, scoped to the discount-proofs bucket. */
async function getSignedDiscountProofUrl(key: string): Promise<string> {
  const { data, error } = await supabaseAdmin.storage.from(DISCOUNT_PROOF_BUCKET).createSignedUrl(key, 60 * 60);
  if (error || !data) throw new TransactionError('DISCOUNT_PROOF_URL_FAILED', 'Could not generate discount proof URL', 500);
  return data.signedUrl;
}

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function round2(amount: number): number {
  return toCents(amount) / 100;
}

/** Compact Manila calendar date (YYYYMMDD) for the receipt-number prefix — the receipt date must be the Philippine transaction date, never the UTC date. */
function isoDateCompact(date: Date): string {
  return manilaDateKey(date).replace(/-/g, '');
}

interface TransactionItemRow {
  id: string;
  productId: string;
  productVariantId: string;
  flavorId: string | null;
  productNameSnapshot: string;
  variantNameSnapshot: string;
  flavorNameSnapshot: string | null;
  unitPriceSnapshot: { toNumber(): number };
  quantity: number;
  lineTotal: { toNumber(): number };
  recipeVersion: number;
  selectedOptions?: SelectedOptionSnapshot[] | null;
}

interface TransactionRow {
  id: string;
  transactionNumber: string;
  branchId: string;
  shiftId: string | null;
  cashierId: string;
  status: string;
  paymentMethod: string;
  subtotal: { toNumber(): number };
  discountAmount: { toNumber(): number };
  discountType: string | null;
  vatAmount: { toNumber(): number };
  vatExemptAmount: { toNumber(): number };
  totalAmount: { toNumber(): number };
  amountTendered: { toNumber(): number } | null;
  changeAmount: { toNumber(): number } | null;
  gcashReference: string | null;
  gcashManuallyVerified: boolean | null;
  paymentProofKey: string | null;
  paymentProofType: string | null;
  paymentProofUploadedAt: Date | null;
  discountProofKey: string | null;
  discountProofType: string | null;
  discountProofUploadedAt: Date | null;
  receiptPrinted: boolean;
  inventoryDeductionStatus: string;
  isOfflineTransaction: boolean;
  offlineProvisionalNumber: string | null;
  syncedAt: Date | null;
  voidedAt: Date | null;
  voidedById: string | null;
  voidReason: string | null;
  refundedAt: Date | null;
  refundedById: string | null;
  refundReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  items?: TransactionItemRow[];
  shift?: { id: string; status: string; branchId: string } | null;
}

function toTransactionResponse(row: TransactionRow) {
  return {
    id: row.id,
    receipt_number: row.transactionNumber,
    branch_id: row.branchId,
    shift_id: row.shiftId,
    cashier_id: row.cashierId,
    status: row.status,
    payment_method: row.paymentMethod,
    subtotal: row.subtotal.toNumber(),
    discount_amount: row.discountAmount.toNumber(),
    discount_type: row.discountType,
    vat_amount: row.vatAmount.toNumber(),
    vat_exempt_amount: row.vatExemptAmount.toNumber(),
    total_amount: row.totalAmount.toNumber(),
    cash_tendered: row.amountTendered?.toNumber() ?? null,
    change_given: row.changeAmount?.toNumber() ?? null,
    gcash_reference_number: row.gcashReference,
    // Generic alias — gcashReference is reused as the reference/note column
    // for gcash, maya, and other alike (see createTransaction's referenceNote).
    payment_reference: row.gcashReference,
    gcash_manually_verified: row.gcashManuallyVerified,
    has_payment_proof: row.paymentProofKey !== null,
    payment_proof_type: row.paymentProofType,
    payment_proof_uploaded_at: row.paymentProofUploadedAt?.toISOString() ?? null,
    has_discount_proof: row.discountProofKey !== null,
    discount_proof_type: row.discountProofType,
    discount_proof_uploaded_at: row.discountProofUploadedAt?.toISOString() ?? null,
    receipt_printed: row.receiptPrinted,
    inventory_deduction_status: row.inventoryDeductionStatus,
    is_offline_transaction: row.isOfflineTransaction,
    offline_provisional_number: row.offlineProvisionalNumber,
    synced_at: row.syncedAt?.toISOString() ?? null,
    voided_at: row.voidedAt?.toISOString() ?? null,
    voided_by_id: row.voidedById,
    void_reason: row.voidReason,
    refunded_at: row.refundedAt?.toISOString() ?? null,
    refunded_by_id: row.refundedById,
    refund_reason: row.refundReason,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    items: row.items?.map((item) => ({
      id: item.id,
      product_id: item.productId,
      product_variant_id: item.productVariantId,
      flavor_id: item.flavorId,
      product_name: item.productNameSnapshot,
      variant_name: item.variantNameSnapshot,
      flavor_name: item.flavorNameSnapshot,
      unit_price: item.unitPriceSnapshot.toNumber(),
      quantity: item.quantity,
      line_total: item.lineTotal.toNumber(),
      recipe_version: item.recipeVersion,
      selected_options: (item.selectedOptions ?? []).map((option) => ({
        option_id: option.optionId,
        option_name: option.optionName,
        option_group_id: option.optionGroupId,
        option_group_name: option.optionGroupName,
        price_adjustment: option.priceAdjustment,
      })),
    })),
  };
}

interface HoldOrderItemRow {
  id: string;
  productId: string;
  productVariantId: string;
  flavorId: string | null;
  productNameSnapshot: string;
  variantNameSnapshot: string;
  flavorNameSnapshot: string | null;
  unitPriceSnapshot: { toNumber(): number };
  quantity: number;
}

interface HoldOrderRow {
  id: string;
  branchId: string;
  shiftId: string;
  cashierId: string;
  status: string;
  expiresAt: Date;
  releasedAt: Date | null;
  expiredAt: Date | null;
  createdAt: Date;
  items: HoldOrderItemRow[];
}

function toHoldOrderResponse(row: HoldOrderRow) {
  return {
    id: row.id,
    branch_id: row.branchId,
    shift_id: row.shiftId,
    cashier_id: row.cashierId,
    status: row.status,
    expires_at: row.expiresAt.toISOString(),
    released_at: row.releasedAt?.toISOString() ?? null,
    expired_at: row.expiredAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    items: row.items.map((item) => ({
      id: item.id,
      product_id: item.productId,
      product_variant_id: item.productVariantId,
      flavor_id: item.flavorId,
      product_name: item.productNameSnapshot,
      variant_name: item.variantNameSnapshot,
      flavor_name: item.flavorNameSnapshot,
      unit_price: item.unitPriceSnapshot.toNumber(),
      quantity: item.quantity,
    })),
  };
}

interface ResolvedItem {
  // Pre-generated here (not left to the DB default) so it can be threaded
  // through to the TransactionItem create payload below.
  id: string;
  productId: string;
  productVariantId: string;
  flavorId: string | null;
  productName: string;
  variantName: string;
  flavorName: string | null;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  // Computed once here (read-only, outside the write transaction) and
  // written directly into the TransactionItem's create payload —
  // TransactionItem rows are immutable after creation (CR-004), so this can
  // never be patched in afterward.
  deductionLines: BomDeductionLine[];
  vatableCapAmount: number | null;
  recipeVersion: number;
  selectedFlavors?: { slotIndex: number; snackProductVariantId: string; flavorId: string }[] | null;
  selectedOptions?: SelectedOptionSnapshot[] | null;
}

/**
 * Priority-ordered mapping from productReadinessService's blockingIssues down
 * to a single stable checkout TransactionError — same "first match wins"
 * approach as products.service.ts#pickLegacyReadinessCode (Phase B), so the
 * POS catalog and checkout can never disagree about why a variant is
 * unsellable. Existing checkout error codes are reused wherever the meaning
 * lines up; new codes are added only where no existing one fits.
 */
const READINESS_TRANSACTION_ERRORS: { codes: string[]; txCode: string; message: (variantName: string) => string }[] = [
  {
    codes: ['PRODUCT_INACTIVE', 'VARIANT_INACTIVE', 'VARIANT_LIFECYCLE_BLOCKED'],
    txCode: 'PRODUCT_UNAVAILABLE',
    message: (name) => `${name} is not currently sellable`,
  },
  {
    codes: ['BRANCH_NOT_AVAILABLE'],
    txCode: 'PRODUCT_UNAVAILABLE',
    message: (name) => `${name} is not available at this branch`,
  },
  {
    codes: ['PRICE_MISSING'],
    txCode: 'PRICE_MISSING',
    message: (name) => `${name} does not have a valid price configured`,
  },
  {
    codes: ['RECIPE_MISSING', 'INVALID_COMPONENT', 'INVENTORY_STOCK_MISSING'],
    txCode: 'RECIPE_MISSING',
    message: (name) => `${name} has no inventory mapping configured for this branch`,
  },
  {
    codes: ['FLAVOR_NOT_AVAILABLE_AT_BRANCH'],
    txCode: 'FLAVOR_NOT_AVAILABLE_FOR_VARIANT',
    message: () => 'The selected flavor is not available at this branch',
  },
  {
    codes: ['MIX_MAX_SLOT_INCOMPLETE', 'MIX_MAX_SNACK_UNAVAILABLE'],
    txCode: 'MIX_MAX_SLOT_INCOMPLETE',
    message: (name) => `${name} is not fully configured for sale at this branch`,
  },
];

/** Never surfaces internal ids or admin recommendedAction text — only a cashier-safe product/flavor name and a stable public code. */
function readinessRejection(variantName: string, result: ProductVariantReadinessResult): TransactionError {
  for (const entry of READINESS_TRANSACTION_ERRORS) {
    if (result.blockingIssues.some((issue) => entry.codes.includes(issue.code))) {
      return new TransactionError(entry.txCode, entry.message(variantName), 422);
    }
  }
  return new TransactionError('PRODUCT_UNAVAILABLE', `${variantName} is not currently sellable`, 422);
}

interface SelectedOptionsResolution {
  premium: number;
  snapshot: SelectedOptionSnapshot[];
}

/**
 * CR-008 Product Options server-side pricing (Task 32), extended in Task 93
 * to also produce the sale-time snapshot persisted on TransactionItem. Sums
 * the trusted DB priceAdjustment/name for each selectedOptionIds entry —
 * never the frontend-provided display price/name — rejecting the whole
 * transaction if any selected option doesn't exist, isn't active, or isn't
 * actually assigned to this variant (variant.optionGroupAssignments is the
 * same ProductVariantOptionGroupOption-scoped "allowed options" set the
 * Product Builder UI enforces, so pricing can never disagree with what was
 * offered).
 *
 * Task 105 — an assignment with zero allowedOptions rows means "all active
 * options in the group" (CR-008 R11/R12 "control allowed options" — see
 * products.service.ts's getPosCatalog option_groups mapping, the source the
 * POS terminal renders selectable options from). This must apply the exact
 * same fallback, or checkout rejects an option the POS itself offered.
 */
function resolveSelectedOptions(
  variant: {
    name: string;
    optionGroupAssignments?: {
      optionGroup: {
        id: string;
        name: string;
        posButtonLabel: string | null;
        options: { id: string; name: string; isActive: boolean; priceAdjustment: { toNumber(): number } }[];
      };
      allowedOptions: {
        productOptionId: string;
        productOption: { id: string; name: string; isActive: boolean; priceAdjustment: { toNumber(): number } };
      }[];
    }[];
  },
  selectedOptionIds: string[] | undefined,
): SelectedOptionsResolution {
  if (!selectedOptionIds || selectedOptionIds.length === 0) return { premium: 0, snapshot: [] };

  const allowedOptions = new Map<
    string,
    { priceAdjustment: number; optionName: string; optionGroupId: string; optionGroupName: string }
  >();
  for (const assignment of variant.optionGroupAssignments ?? []) {
    const optionGroupName = assignment.optionGroup.posButtonLabel?.trim() || assignment.optionGroup.name;
    // Empty allowedOptions means "all options" — fall back to every active
    // option in the assigned group, mirroring getPosCatalog exactly.
    const effectiveOptions =
      assignment.allowedOptions.length > 0
        ? assignment.allowedOptions.map((allowed) => ({ productOptionId: allowed.productOptionId, productOption: allowed.productOption }))
        : assignment.optionGroup.options.map((option) => ({ productOptionId: option.id, productOption: option }));
    for (const allowed of effectiveOptions) {
      if (allowed.productOption.isActive) {
        allowedOptions.set(allowed.productOptionId, {
          priceAdjustment: allowed.productOption.priceAdjustment.toNumber(),
          optionName: allowed.productOption.name,
          optionGroupId: assignment.optionGroup.id,
          optionGroupName,
        });
      }
    }
  }

  let premium = 0;
  const snapshot: SelectedOptionSnapshot[] = [];
  for (const optionId of selectedOptionIds) {
    const resolved = allowedOptions.get(optionId);
    if (resolved === undefined) {
      throw new TransactionError('PRODUCT_OPTION_NOT_AVAILABLE', `Selected product option is not available for ${variant.name}`, 422);
    }
    premium += resolved.priceAdjustment;
    snapshot.push({
      optionId,
      optionName: resolved.optionName,
      optionGroupId: resolved.optionGroupId,
      optionGroupName: resolved.optionGroupName,
      priceAdjustment: resolved.priceAdjustment,
    });
  }
  return { premium, snapshot };
}

/**
 * Task 100 — computeBomDeduction/computeComponentDeductionForSlots (the base
 * Recipe/BOM path) throw the same UnitConversionError as the Product Option
 * mapping path below when a component's recipeUnitId has no UnitConversion
 * row to its InventoryItem's baseUnitId. Task 99 only wrapped the option
 * path's own convertQuantity call, so this structurally identical gap in the
 * base recipe path was still reaching app.ts's generic 500 handler as an
 * opaque "Something went wrong", independent of whether the cart item had
 * any Product Options selected at all.
 */
async function computeBaseRecipeDeductionOrThrow(compute: () => Promise<BomDeductionLine[]>): Promise<BomDeductionLine[]> {
  try {
    return await compute();
  } catch (error) {
    if (error instanceof UnitConversionError) {
      throw new TransactionError(
        'RECIPE_INVENTORY_UNIT_MISMATCH',
        'The recipe for this product has an ingredient with no unit conversion configured for its deduction unit',
        422,
      );
    }
    throw error;
  }
}

/**
 * Task 79 — Product Option inventory deduction, layered on top of the base
 * Recipe/BOM deduction. ProductOptionInventoryMapping (one row per option)
 * is the source of truth, replacing the legacy ProductComponent.productOptionId
 * rows (resolveCartItems no longer forwards selectedOptionIds into
 * computeBomDeduction — see the call below). An option with no mapping row
 * deducts nothing and never fails pricing: resolveSelectedOptions
 * already validates the option itself exists / is active / is assigned to
 * this variant. quantityRequired is converted from the mapping's own
 * deductionUnitId into the mapped InventoryItem's base unit via the same
 * convertQuantity utility the base BOM path uses (fails closed if no
 * UnitConversion row supports it), then scaled by cart quantity.
 */
async function computeOptionDeductionLines(selectedOptionIds: string[] | undefined, quantitySold: number): Promise<BomDeductionLine[]> {
  if (!selectedOptionIds || selectedOptionIds.length === 0) return [];

  const mappings = await transactionsRepository.findOptionInventoryMappings(selectedOptionIds);
  const map = new Map<string, BomDeductionLine>();
  for (const mapping of mappings) {
    if (mapping.inventoryItem.deletedAt !== null) {
      throw new TransactionError(
        'PRODUCT_OPTION_INVENTORY_INACTIVE',
        'The inventory item mapped to a selected Product Option is no longer active',
        422,
      );
    }
    // convertQuantity throws UnitConversionError (not TransactionError) when
    // no UnitConversion row bridges the mapping's deductionUnitId to the
    // InventoryItem's baseUnitId — left uncaught, that foreign error type
    // skips the router's `instanceof TransactionError` check (transactions.
    // router.ts#handleModuleError) and falls through to app.ts's generic
    // handler, so a real, fixable config gap (missing UnitConversion row)
    // surfaced to the cashier as an opaque "Something went wrong" instead of
    // a checkout-safe, actionable rejection. Translate it here the same way
    // the deletedAt check above does for its own failure mode.
    let baseQuantity;
    try {
      baseQuantity = await convertQuantity(mapping.quantityRequired, mapping.deductionUnitId, mapping.inventoryItem.baseUnitId, mapping.inventoryItemId);
    } catch (error) {
      if (error instanceof UnitConversionError) {
        throw new TransactionError(
          'PRODUCT_OPTION_INVENTORY_UNIT_MISMATCH',
          'The inventory item mapped to a selected Product Option has no unit conversion configured for its deduction unit',
          422,
        );
      }
      throw error;
    }
    const quantity = baseQuantity.toNumber() * quantitySold;
    const existing = map.get(mapping.inventoryItemId);
    if (existing) {
      existing.quantity += quantity;
    } else {
      map.set(mapping.inventoryItemId, { inventoryItemId: mapping.inventoryItemId, baseUnitId: mapping.inventoryItem.baseUnitId, quantity });
    }
  }
  return Array.from(map.values());
}

/** Merges two BomDeductionLine arrays by inventoryItemId, summing quantities for lines both sides deduct. */
function mergeDeductionLines(base: BomDeductionLine[], extra: BomDeductionLine[]): BomDeductionLine[] {
  const map = new Map<string, BomDeductionLine>();
  for (const line of [...base, ...extra]) {
    const existing = map.get(line.inventoryItemId);
    if (existing) {
      existing.quantity += line.quantity;
    } else {
      map.set(line.inventoryItemId, { ...line });
    }
  }
  return Array.from(map.values());
}

/**
 * Resolves and prices every cart line against the live catalog — never
 * trusts a client-submitted price. Rejects the whole transaction if any
 * item references a variant/flavor that isn't active, sellable at this
 * product's global status, or available at this branch (architecture doc
 * §Transaction flow: "unavailable items hidden" applies just as much to
 * what the server accepts as what the client displays).
 *
 * Sellability itself (active/lifecycle/price/branch availability/inventory
 * mapping/Mix & Max configuration completeness) is gated once per cart via
 * productReadinessService — the same authoritative engine the POS catalog
 * uses (Phase C) — so the two can never disagree. Everything below the
 * readiness gate validates the customer's actual selection (which flavor,
 * which slot), which the readiness engine deliberately does not evaluate.
 */
async function resolveCartItems(branchId: string, items: CartItemInput[]): Promise<ResolvedItem[]> {
  const variantIds = [...new Set(items.map((i) => i.productVariantId))];
  const variants = await transactionsRepository.findVariantsForSale(variantIds);
  const variantMap = new Map(variants.map((v) => [v.id, v]));
  const readinessResults = await productReadinessService.evaluateProductVariantReadinessForVariants(branchId, variants, variantIds);
  const readinessMap = new Map(readinessResults.map((r) => [r.productVariantId, r]));

  const productIds = [
    ...new Set(
      variants.flatMap((v) => [
        v.productId,
        ...(v.flavorSlots ?? []).flatMap((s) => s.snackOptions.map((so) => so.snackProductVariant.product.id)),
      ]),
    ),
  ];
  const productAvailability = await transactionsRepository.findBranchProductAvailabilityMap(branchId, productIds);
  const productAvailabilityMap = new Map(productAvailability.map((r) => [r.productId, r.isAvailable]));

  const slotFlavorIds = items.flatMap((i) => (i.selectedFlavors ?? []).map((sf) => sf.flavorId));
  const flavorIds = [...new Set([...items.filter((i) => i.flavorId).map((i) => i.flavorId as string), ...slotFlavorIds])];
  const flavorAvailability = flavorIds.length
    ? await transactionsRepository.findBranchFlavorAvailabilityMap(branchId, flavorIds)
    : [];
  const flavorAvailabilityMap = new Map(flavorAvailability.map((r) => [r.flavorId, r.isAvailable]));

  // Task 209.3 — each item's resolution (recipe-version lookup + BOM
  // deduction computation) only reads data already snapshotted above
  // (variantMap/readinessMap/productAvailabilityMap/flavorAvailabilityMap)
  // plus its own pure, side-effect-free DB reads (getVersionForVariant,
  // computeBomDeduction, computeOptionDeductionLines) — nothing here writes,
  // locks, or depends on another item's result, and this all runs before the
  // atomic write transaction below, so resolving every cart line concurrently
  // instead of one-by-one is safe. This was the dominant serial cost for a
  // multi-item cart (one recipe-version + BOM round trip per line, back to
  // back).
  const resolved: ResolvedItem[] = await Promise.all(
    items.map(async (item) => {
    const variant = variantMap.get(item.productVariantId);
    if (!variant || variant.productId !== item.productId) {
      throw new TransactionError('PRODUCT_UNAVAILABLE', `Product variant ${item.productVariantId} is not available for sale`, 422);
    }

    const readiness = readinessMap.get(variant.id);
    if (readiness && !readiness.sellable) {
      throw readinessRejection(`${variant.product.name} — ${variant.name}`, readiness);
    }

    let flavorName: string | null = null;
    let pricePremium = 0;
    let deductionLines: BomDeductionLine[];
    let recipeVersion: number;
    let selectedFlavors: { slotIndex: number; snackProductVariantId: string; flavorId: string }[] | null = null;

    const flavorSlots = variant.flavorSlots ?? [];
    if (flavorSlots.length > 0) {
      // Mix & Max: exactly one submitted (snack + flavor) per
      // ProductFlavorSlot, no duplicates, no unknown slot indexes, no extras.
      const submitted = item.selectedFlavors ?? [];
      if (submitted.length !== flavorSlots.length) {
        throw new TransactionError(
          'FLAVOR_SLOTS_INCOMPLETE',
          `${variant.name} requires exactly ${flavorSlots.length} flavor selection(s), received ${submitted.length}`,
          422,
        );
      }
      const seenSlotIndexes = new Set<number>();
      const slotByIndex = new Map(flavorSlots.map((s) => [s.slotIndex, s]));
      let premiumTotal = 0;
      const names: string[] = [];
      for (const sel of submitted) {
        if (!sel.flavorId || !sel.snackProductVariantId) {
          throw new TransactionError('FLAVOR_SLOTS_INVALID', 'Every flavor slot requires a snack_product_variant_id and flavorId', 422);
        }
        const slot = slotByIndex.get(sel.slotIndex);
        if (!slot) {
          throw new TransactionError('FLAVOR_SLOTS_INVALID', `Unknown slot index ${sel.slotIndex} for ${variant.name}`, 422);
        }
        if (seenSlotIndexes.has(sel.slotIndex)) {
          throw new TransactionError('FLAVOR_SLOTS_INVALID', `Duplicate slot index ${sel.slotIndex} for ${variant.name}`, 422);
        }
        seenSlotIndexes.add(sel.slotIndex);

        const snackOption = slot.snackOptions.find((so) => so.snackProductVariantId === sel.snackProductVariantId);
        if (!snackOption) {
          throw new TransactionError('PRODUCT_UNAVAILABLE', `Selected snack is not offered for slot ${slot.slotIndex} of ${variant.name}`, 422);
        }
        const snackVariant = snackOption.snackProductVariant;
        if (!snackVariant.isActive || snackVariant.product.status !== 'active') {
          throw new TransactionError('PRODUCT_UNAVAILABLE', 'Selected snack is not currently sellable', 422);
        }
        if (productAvailabilityMap.get(snackVariant.product.id) !== true) {
          throw new TransactionError('PRODUCT_UNAVAILABLE', 'Selected snack is not available at this branch', 422);
        }
        // The parent variant's own readiness gate above already requires
        // MIX_MAX_SNACK_UNAVAILABLE-free slots (every offered snack option
        // has an active Recipe/BOM) before reaching this loop — see
        // product-readiness.service.ts buildReadinessResult.

        const link = snackVariant.variantFlavors.find((vf) => vf.flavorId === sel.flavorId);
        if (!link || !link.isAvailable || !link.flavor.isActive) {
          throw new TransactionError('PRODUCT_UNAVAILABLE', 'Selected flavor is not available for the chosen snack', 422);
        }
        if (flavorAvailabilityMap.get(sel.flavorId) === false) {
          throw new TransactionError('PRODUCT_UNAVAILABLE', 'Selected flavor is not available at this branch', 422);
        }
        premiumTotal += link.pricePremium.toNumber();
        names.push(`${link.flavor.name}`);
      }
      pricePremium = premiumTotal;
      flavorName = names.join(' / ');
      const resolvedSelectedFlavors = submitted.map((s) => ({ slotIndex: s.slotIndex, snackProductVariantId: s.snackProductVariantId, flavorId: s.flavorId }));
      selectedFlavors = resolvedSelectedFlavors;

      recipeVersion = await productComponentsRepository.getVersionForVariant(variant.id);
      deductionLines = await computeBaseRecipeDeductionOrThrow(() => computeComponentDeductionForSlots(variant.id, resolvedSelectedFlavors, item.quantity, branchId));
    } else {
      const activeFlavorLinks = variant.variantFlavors.filter((vf) => vf.isAvailable && vf.flavor.isActive);
      if (!item.flavorId && activeFlavorLinks.length > 0) {
        throw new TransactionError('FLAVOR_SELECTION_REQUIRED', `${variant.name} requires a flavor selection`, 422);
      }
      if (item.flavorId) {
        const link = variant.variantFlavors.find((vf) => vf.flavorId === item.flavorId);
        if (!link || !link.isAvailable || !link.flavor.isActive) {
          throw new TransactionError('FLAVOR_NOT_AVAILABLE_FOR_VARIANT', `Selected flavor is not available for ${variant.name}`, 422);
        }
        if (flavorAvailabilityMap.get(item.flavorId) === false) {
          throw new TransactionError('FLAVOR_NOT_AVAILABLE_FOR_VARIANT', 'Selected flavor is not available at this branch', 422);
        }
        flavorName = link.flavor.name;
        pricePremium = link.pricePremium.toNumber();
      }

      recipeVersion = await productComponentsRepository.getVersionForVariant(variant.id);
      deductionLines = await computeBaseRecipeDeductionOrThrow(() => computeBomDeduction(variant.id, branchId, item.quantity, item.flavorId ?? null));
    }

    const { premium: optionsPremium, snapshot: selectedOptions } = resolveSelectedOptions(variant, item.selectedOptionIds);
    const optionDeductionLines = await computeOptionDeductionLines(item.selectedOptionIds, item.quantity);
    if (optionDeductionLines.length > 0) {
      deductionLines = mergeDeductionLines(deductionLines, optionDeductionLines);
    }
    const basePrice = variant.basePrice.toNumber();
    const unitPrice = round2(basePrice + pricePremium + optionsPremium);
    const lineTotal = round2(unitPrice * item.quantity);

    return {
      id: randomUUID(),
      productId: variant.productId,
      productVariantId: variant.id,
      flavorId: flavorSlots.length > 0 ? null : (item.flavorId ?? null),
      productName: variant.product.name,
      variantName: variant.name,
      flavorName,
      unitPrice,
      quantity: item.quantity,
      lineTotal,
      vatableCapAmount: variant.vatableCapAmount?.toNumber() ?? null,
      recipeVersion,
      deductionLines,
      selectedFlavors,
      selectedOptions: selectedOptions.length > 0 ? selectedOptions : null,
    };
    }),
  );
  return resolved;
}

/**
 * Mix & Max slot deduction on the new model: the parent variant's own active
 * Recipe/BOM (ProductComponent) rows represent packaging (box/cup), resolved
 * once regardless of slot count; each slot's actual consumption is resolved
 * against the *selected snack's own* active components. Mirrors the retired
 * product-inventory.service.ts#computeDeductionForSlots exactly in shape.
 */
async function computeComponentDeductionForSlots(
  productVariantId: string,
  selectedFlavors: { slotIndex: number; snackProductVariantId: string; flavorId: string }[],
  quantitySold: number,
  branchId: string,
): Promise<BomDeductionLine[]> {
  const packagingLines = await computeBomDeduction(productVariantId, branchId, 1);
  const map = new Map(packagingLines.map((line) => [line.inventoryItemId, { ...line }]));

  for (const selection of selectedFlavors) {
    const lines = await computeBomDeduction(selection.snackProductVariantId, branchId, 1);
    for (const line of lines) {
      const existing = map.get(line.inventoryItemId);
      map.set(line.inventoryItemId, { ...line, quantity: (existing?.quantity ?? 0) + line.quantity });
    }
  }

  return Array.from(map.values()).map((line) => ({ ...line, quantity: line.quantity * quantitySold }));
}

interface ComputedAmounts {
  discountAmount: number;
  vatAmount: number;
  vatExemptAmount: number;
  totalAmount: number;
}

/**
 * VAT + discount calculation. PWD/Senior Citizen sales are true VAT-exempt
 * transactions per RA 9994 / RA 10754 (confirmed by business owner) — VAT is
 * never charged on the discounted base, not even added back. Every other
 * discount type (or none) uses the general VAT-inclusive-pricing extraction:
 * the VAT component is embedded in the post-discount total, not added on
 * top of it.
 */
export function computeAmounts(
  subtotal: number,
  items: ResolvedItem[],
  discountType: CreateTransactionData['discountType'],
): ComputedAmounts {
  const vatableSubtotal = round2(
    items.reduce((sum, item) => {
      const cap = item.vatableCapAmount;
      const vatableLine = cap != null ? Math.min(item.lineTotal, round2(cap * item.quantity)) : item.lineTotal;
      return sum + vatableLine;
    }, 0),
  );
  const nonVatableSubtotal = round2(subtotal - vatableSubtotal);

  if (discountType === DISCOUNT_TYPE.PWD || discountType === DISCOUNT_TYPE.SENIOR_CITIZEN) {
    const vatableBase = vatableSubtotal / 1.12;
    const discountAmount = round2(vatableBase * STATUTORY_DISCOUNT_RATE);
    const discountedBase = round2(vatableBase - discountAmount);
    const totalAmount = round2(discountedBase + nonVatableSubtotal);
    return { discountAmount, vatAmount: 0, vatExemptAmount: nonVatableSubtotal, totalAmount };
  }

  let discountAmount = 0;
  if (discountType === DISCOUNT_TYPE.EMPLOYEE) {
    discountAmount = round2(vatableSubtotal * EMPLOYEE_DISCOUNT_RATE);
  }
  const vatableAfterDiscount = round2(vatableSubtotal - discountAmount);
  const vatAmount = round2(vatableAfterDiscount * (12 / 112));
  const totalAfterDiscount = round2(vatableAfterDiscount + nonVatableSubtotal);
  return { discountAmount, vatAmount, vatExemptAmount: nonVatableSubtotal, totalAmount: totalAfterDiscount };
}

async function generateReceiptNumber(branchCode: string, attempt: number): Promise<string> {
  const prefix = `${branchCode}-${isoDateCompact(new Date())}-`;
  const count = await transactionsRepository.countTransactionsWithPrefix(prefix);
  const sequence = count + 1 + attempt;
  return `${prefix}${String(sequence).padStart(6, '0')}`;
}

/**
 * Runs inside the same DB transaction as the sale itself (Phase 8's deduction
 * moved from a fire-and-forget queue job to here) so a stock shortfall rolls
 * back the whole sale instead of leaving a completed transaction with no
 * matching deduction. Side effects that aren't part of the atomic write
 * (audit log, notifications, socket broadcasts) are returned as deferred
 * callbacks and only run after the transaction commits.
 */
async function deductInventoryForSale(
  tx: Prisma.TransactionClient,
  branchId: string,
  transactionId: string,
  items: { lines: BomDeductionLine[] }[],
): Promise<Array<() => Promise<void>>> {
  const totals = new Map<string, { quantity: number; baseUnitId: string }>();
  for (const item of items) {
    for (const line of item.lines) {
      const existing = totals.get(line.inventoryItemId);
      totals.set(line.inventoryItemId, { quantity: (existing?.quantity ?? 0) + line.quantity, baseUnitId: line.baseUnitId });
    }
  }

  // Deterministic order (sorted by inventoryItemId) for every pass below,
  // locks included — two transactions deducting an overlapping ingredient
  // set must always request their advisory locks in the same order, or
  // Postgres can deadlock them against each other instead of one simply
  // waiting for the other.
  const sortedEntries = [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const inventoryItemIds = sortedEntries.map(([id]) => id);

  const itemNames = new Map(
    (await tx.inventoryItem.findMany({ where: { id: { in: inventoryItemIds } }, select: { id: true, name: true } })).map((i) => [
      i.id,
      i.name,
    ]),
  );

  // One pg_advisory_xact_lock call per ingredient (same primitive as
  // before), now taken up front in sorted order before any read — every
  // concurrent sale touching an overlapping ingredient set serializes on
  // this same lock order instead of racing.
  for (const inventoryItemId of inventoryItemIds) {
    const lockId = hashToLockId(sha256Hex(inventoryItemId));
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
  }

  // One batched read for every InventoryStock row instead of one
  // findUnique per ingredient — safe to treat as a single snapshot because
  // every row's advisory lock is already held above, so nothing else can
  // change them out from under this pass.
  const stockRows = await tx.inventoryStock.findMany({
    where: { branchId, inventoryItemId: { in: inventoryItemIds } },
  });
  const stockByItemId = new Map(stockRows.map((row) => [row.inventoryItemId, row]));

  // Validate every row before writing any of them — a shortfall anywhere in
  // the cart must still roll back the whole sale, never leave a partial
  // deduction behind.
  for (const [inventoryItemId, { quantity }] of sortedEntries) {
    const stock = stockByItemId.get(inventoryItemId);
    const currentStock = stock?.quantityOnHand.toNumber() ?? 0;
    if (!stock || currentStock < quantity) {
      const itemName = itemNames.get(inventoryItemId) ?? inventoryItemId;
      throw new TransactionError(
        'INSUFFICIENT_STOCK',
        `Insufficient stock for ${itemName}: need ${quantity}, have ${currentStock}`,
        409,
      );
    }
  }

  // Prisma has no single-call bulk update for rows that each decrement by a
  // different quantity, so this pass still costs one `update` per
  // ingredient — the locks taken above already make each of these safe
  // against a concurrent writer, so the round trips saved were entirely in
  // the read and ledger-insert passes around it.
  const effects: Array<() => Promise<void>> = [];
  const movementInputs: Parameters<typeof universalInventoryRepository.createStockMovements>[0] = [];

  for (const [inventoryItemId, { quantity, baseUnitId }] of sortedEntries) {
    const stock = stockByItemId.get(inventoryItemId);
    if (!stock) continue; // unreachable — every row was validated above
    const itemName = itemNames.get(inventoryItemId) ?? inventoryItemId;

    const updated = await tx.inventoryStock.update({
      where: { branchId_inventoryItemId: { branchId, inventoryItemId } },
      data: { quantityOnHand: { decrement: quantity }, version: { increment: 1 } },
    });

    movementInputs.push({
      branchId,
      inventoryItemId,
      movementType: 'SALE',
      quantityChange: new Prisma.Decimal(quantity).negated(),
      quantityBefore: stock.quantityOnHand,
      quantityAfter: updated.quantityOnHand,
      unitId: baseUnitId,
      referenceType: 'transaction',
      referenceId: transactionId,
    });

    effects.push(() =>
      recordAuditLog({
        action: 'INVENTORY_SALE_DEDUCTED',
        entityType: 'inventory_stock',
        entityId: updated.id,
        actorId: null,
        actorRole: 'system',
        branchId,
        afterState: {
          inventory_item_id: inventoryItemId,
          quantity_change: -quantity,
          quantity_after: updated.quantityOnHand.toNumber(),
          reference_id: transactionId,
        },
      }),
    );

    const stockAfter = updated.quantityOnHand.toNumber();
    const lowThreshold = updated.lowStockThreshold?.toNumber() ?? null;
    const criticalThreshold = updated.criticalThreshold?.toNumber() ?? null;
    if (lowThreshold !== null && stockAfter <= lowThreshold) {
      effects.push(() =>
        enqueueRawNotificationJob('low_stock_alert', {
          branchId,
          inventoryItemId,
          ingredientName: itemName,
          currentStock: stockAfter,
          lowStockThreshold: lowThreshold,
          criticalThreshold: criticalThreshold ?? lowThreshold,
          severity: criticalThreshold !== null && stockAfter <= criticalThreshold ? 'critical' : 'low',
        }),
      );
    }
  }

  // One batched insert for every SALE movement row instead of one `create`
  // per ingredient.
  if (movementInputs.length > 0) {
    await universalInventoryRepository.createStockMovements(movementInputs, tx);
  }

  await inventoryRepository.updateTransactionDeductionStatus(transactionId, INVENTORY_DEDUCTION_STATUS.COMPLETED, tx);

  return effects;
}

/**
 * Reverses a completed sale's inventory deduction when a transaction is
 * voided or refunded — same recipe deduction math as deductInventoryForSale,
 * with quantityChange flipped positive to add stock back. Runs inside the
 * caller's $transaction so the reversal commits atomically with the status
 * update. Recorded as movement_type manual_adjustment (no dedicated reversal
 * type exists on the InventoryMovement enum), referencing the original
 * transaction ID.
 */
async function reverseInventoryForTransaction(
  tx: Prisma.TransactionClient,
  branchId: string,
  transactionId: string,
  // Superseded by the deductionSnapshot-driven fetch below (kept in the
  // signature so both call sites stay unchanged).
  _items: { productVariantId: string; flavorId: string | null; quantity: number }[],
  kind: 'void' | 'refund',
): Promise<void> {
  const transactionItems = await tx.transactionItem.findMany({
    where: { transactionId },
    select: { productVariantId: true, flavorId: true, quantity: true, deductionSnapshot: true },
  });

  // Two snapshot shapes coexist: transactions created before this cutover
  // recorded a legacy ingredient-keyed snapshot (reversed against
  // Ingredient/InventoryMovement, unchanged below); transactions created
  // after it record an inventoryItem-keyed snapshot (reversed against
  // InventoryStock). Never cross-apply one shape's totals to the other
  // system — that would corrupt whichever stock model didn't actually move.
  const legacyTotals = new Map<string, number>();
  const stockTotals = new Map<string, { quantity: number; baseUnitId?: string }>();

  for (const item of transactionItems) {
    const snapshot = item.deductionSnapshot as
      | { ingredientId: string; quantity: number }[]
      | { inventoryItemId: string; quantity: number; baseUnitId?: string }[]
      | null;

    const firstEntry = snapshot?.[0];
    if (firstEntry && 'inventoryItemId' in firstEntry) {
      for (const entry of snapshot as { inventoryItemId: string; quantity: number; baseUnitId?: string }[]) {
        const existing = stockTotals.get(entry.inventoryItemId);
        stockTotals.set(entry.inventoryItemId, {
          quantity: (existing?.quantity ?? 0) + entry.quantity,
          baseUnitId: entry.baseUnitId ?? existing?.baseUnitId,
        });
      }
      continue;
    }

    if (snapshot && snapshot.length > 0) {
      // Replay exactly what was deducted at sale time instead of
      // recomputing against the (possibly since-changed) recipe/inventory.
      for (const entry of snapshot as { ingredientId: string; quantity: number }[]) {
        legacyTotals.set(entry.ingredientId, (legacyTotals.get(entry.ingredientId) ?? 0) + entry.quantity);
      }
      continue;
    }

    // No snapshot: historical transaction predating the snapshot column
    // entirely. Fall back to the original recompute-from-legacy-recipe
    // behavior — these transactions necessarily predate this cutover too.
    const lines = await computeDeduction({
      productVariantId: item.productVariantId,
      flavorId: item.flavorId,
      quantitySold: item.quantity,
      branchId,
    });
    for (const line of lines) {
      legacyTotals.set(line.ingredient_id, (legacyTotals.get(line.ingredient_id) ?? 0) + line.quantity);
    }
  }

  for (const [ingredientId, quantity] of legacyTotals) {
    const lockId = hashToLockId(sha256Hex(ingredientId));
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;

    await inventoryRepository.appendMovement(
      {
        branchId,
        ingredientId,
        movementType: MOVEMENT_TYPE.MANUAL_ADJUSTMENT,
        quantityChange: quantity,
        referenceId: transactionId,
        notes: `Inventory reversal (${kind}) for transaction ${transactionId}`,
      },
      tx,
    );
  }

  for (const [inventoryItemId, { quantity, baseUnitId }] of stockTotals) {
    const lockId = hashToLockId(sha256Hex(inventoryItemId));
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;

    const stock = await tx.inventoryStock.findUnique({ where: { branchId_inventoryItemId: { branchId, inventoryItemId } } });
    const quantityBefore = stock?.quantityOnHand ?? new Prisma.Decimal(0);

    const updated = await tx.inventoryStock.update({
      where: { branchId_inventoryItemId: { branchId, inventoryItemId } },
      data: { quantityOnHand: { increment: quantity }, version: { increment: 1 } },
    });

    await universalInventoryRepository.createStockMovement(
      {
        branchId,
        inventoryItemId,
        movementType: 'SALE_REVERSAL',
        quantityChange: quantity,
        quantityBefore,
        quantityAfter: updated.quantityOnHand,
        unitId: baseUnitId,
        referenceType: 'transaction',
        referenceId: transactionId,
        notes: `Inventory reversal (${kind}) for transaction ${transactionId}`,
      },
      tx,
    );
  }
}

export const transactionsService = {
  async getDiscountAuditTrail(
    filters: DiscountAuditFilters,
    actor: { id: string; role: string },
    ipAddress: string | null,
  ) {
    const { rows, total } = await transactionsRepository.findDiscountAuditTrail(filters);
    const branchIds = [...new Set(rows.map((r) => r.branchId))];

    const alerts = branchIds.length > 0
      ? await prisma.fraudAlert.findMany({
          where: { alertType: 'discount_id_reuse', branchId: { in: branchIds } },
          select: { branchId: true, status: true, evidence: true },
        })
      : [];

    let decrypted = false;
    const data = rows.map((row) => {
      const fraudFlagged = alerts.some((a) => {
        const evidence = a.evidence as { transaction_ids?: string[] };
        return evidence.transaction_ids?.includes(row.id);
      });

      let discountCustomerId: string | null = null;
      if (row.discountCustomerIdEncrypted && actor.role === 'super_admin') {
        discountCustomerId = decryptField(row.discountCustomerIdEncrypted);
        decrypted = true;
      }

      // Task 209.16 — built field-by-field rather than `...row` so two raw
      // values never leak into the response: `discountProofKey` (the report's
      // privacy rule is proof existence only, never the storage key — same
      // has_discount_proof pattern GET /transactions already uses) and
      // `discountCustomerIdEncrypted` (the ciphertext itself; only the
      // conditionally-decrypted discountCustomerId above should ever leave
      // the server).
      return {
        id: row.id,
        branchId: row.branchId,
        transactionNumber: row.transactionNumber,
        cashierId: row.cashierId,
        discountType: row.discountType,
        // Every other money field returned by this module goes through
        // .toNumber() (see toTransactionResponse above) — this one was
        // missed, leaving a raw Prisma Decimal in the JSON response instead
        // of a number.
        discountAmount: row.discountAmount.toNumber(),
        discountCustomerId,
        discountCustomerIdHash: row.discountCustomerIdHash,
        hasDiscountProof: Boolean(row.discountProofKey),
        discountProofType: row.discountProofType,
        fraudFlagged,
        createdAt: row.createdAt,
      };
    });

    if (decrypted) {
      await recordAuditLog({
        action: 'DISCOUNT_AUDIT_PII_ACCESSED',
        entityType: 'transaction',
        actorId: actor.id,
        actorRole: actor.role,
        ipAddress,
      });
    }

    return { data, total, page: filters.page, limit: filters.limit };
  },

  /**
   * Uploads a payment-proof photo to Storage ahead of transaction creation
   * (see the module comment on why this can't happen inside the atomic
   * $transaction in createTransaction). No Prisma write here at all — the
   * returned key is only persisted once the caller submits it as part of
   * POST /api/transactions. An uploaded-but-never-submitted object (e.g. the
   * cashier abandons the sale) is accepted v1 debt — no sweep job exists for
   * this bucket, matching every other proof-photo bucket in this codebase.
   */
  async uploadPaymentProof(data: UploadPaymentProofData, file: { buffer: Buffer; originalname: string }, actor: ActorContext) {
    const compressed = await sharp(file.buffer)
      .resize({ width: 1200, withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    const path = `${data.branchId}/${data.shiftId}/${actor.id}-${Date.now()}-${sanitizeFilename(file.originalname)}.webp`;
    const { error } = await supabaseAdmin.storage
      .from(PAYMENT_PROOF_BUCKET)
      .upload(path, compressed, { contentType: 'image/webp', upsert: true });
    if (error) {
      throw new TransactionError('PAYMENT_PROOF_UPLOAD_FAILED', 'Failed to upload the payment proof image', 502);
    }

    return { payment_proof_key: path, payment_proof_type: data.type };
  },

  /**
   * Freshly-signed URL for an already-attached proof, generated on demand
   * (never cached). Returns nulls rather than throwing when a transaction
   * has no proof (cash sales, or legacy rows predating this feature) — the
   * admin viewer only ever calls this for a row with has_payment_proof true,
   * but staying tolerant here avoids a spurious error for a stale UI state.
   */
  async getPaymentProofUrl(transactionId: string) {
    const transaction = (await transactionsRepository.findTransactionById(transactionId)) as TransactionRow | null;
    if (!transaction) throw new TransactionError('TRANSACTION_NOT_FOUND', 'Transaction not found', 404);
    if (!transaction.paymentProofKey) {
      return { payment_proof_url: null, payment_proof_type: null, uploaded_at: null };
    }
    return {
      payment_proof_url: await getSignedPaymentProofUrl(transaction.paymentProofKey),
      payment_proof_type: transaction.paymentProofType,
      uploaded_at: transaction.paymentProofUploadedAt?.toISOString() ?? null,
    };
  },

  /**
   * Task 209.5 — uploads a PWD/Senior Citizen discount-proof photo ahead of
   * transaction creation, same "no Prisma write here" rationale as
   * uploadPaymentProof above (a Storage upload must not happen inside the
   * atomic transaction-create write, and the key is only persisted once the
   * cashier submits it with POST /api/transactions). Same v1-orphan
   * acceptance as payment proof: an uploaded-but-never-submitted object gets
   * no sweep job, matching every other proof-photo bucket in this codebase.
   * Audited as DISCOUNT_PROOF_UPLOADED regardless of whether this is the
   * cashier's first capture or a Replace — the server has no way to
   * distinguish the two (each call writes a fresh, uniquely-named object),
   * exactly like payment proof's Replace flow.
   */
  async uploadDiscountProof(data: UploadDiscountProofData, file: { buffer: Buffer; originalname: string }, actor: ActorContext) {
    const compressed = await sharp(file.buffer)
      .resize({ width: 1200, withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    const path = `${data.branchId}/${data.shiftId}/${actor.id}-${Date.now()}-${sanitizeFilename(file.originalname)}.webp`;
    const { error } = await supabaseAdmin.storage
      .from(DISCOUNT_PROOF_BUCKET)
      .upload(path, compressed, { contentType: 'image/webp', upsert: true });
    if (error) {
      throw new TransactionError('DISCOUNT_PROOF_UPLOAD_FAILED', 'Failed to upload the discount proof image', 502);
    }

    await recordAuditLog({
      action: 'DISCOUNT_PROOF_UPLOADED',
      entityType: 'transaction',
      actorId: actor.id,
      actorRole: actor.role,
      branchId: data.branchId,
      afterState: { storageKey: path, type: data.type },
    });

    return { discount_proof_key: path, discount_proof_type: data.type };
  },

  /**
   * Freshly-signed URL for an already-attached discount proof — same
   * tolerant-nulls behavior as getPaymentProofUrl above.
   */
  async getDiscountProofUrl(transactionId: string) {
    const transaction = (await transactionsRepository.findTransactionById(transactionId)) as TransactionRow | null;
    if (!transaction) throw new TransactionError('TRANSACTION_NOT_FOUND', 'Transaction not found', 404);
    if (!transaction.discountProofKey) {
      return { discount_proof_url: null, discount_proof_type: null, uploaded_at: null };
    }
    return {
      discount_proof_url: await getSignedDiscountProofUrl(transaction.discountProofKey),
      discount_proof_type: transaction.discountProofType,
      uploaded_at: transaction.discountProofUploadedAt?.toISOString() ?? null,
    };
  },

  async createTransaction(data: CreateTransactionData, ipAddress: string | null) {
    // Task 209.3 — branch and shift are looked up by independent ids
    // (branchId vs shiftId) with no data dependency between them; running
    // them concurrently instead of back-to-back saves one round trip off
    // every checkout's critical path without changing either validation.
    const [branch, shift] = await Promise.all([
      transactionsRepository.findBranch(data.branchId),
      cashRepository.findShiftById(data.shiftId),
    ]);
    if (!branch) throw new TransactionError('INVALID_SHIFT', 'branch_id does not reference a known branch', 422);

    if (!shift || shift.branchId !== data.branchId) {
      throw new TransactionError('INVALID_SHIFT', 'shift_id does not belong to branch_id', 422);
    }
    if (shift.status !== 'active') {
      throw new TransactionError('SHIFT_CLOSED', 'Cannot record a transaction on a shift that is not open', 409);
    }

    // Presence of cash_tendered (for cash) is already guaranteed by
    // createTransactionSchema's superRefine — only the business-logic checks
    // below belong here.

    // Belt: createTransactionSchema's superRefine already rejects a missing
    // key/type client-side; this is the server-side gate that actually makes
    // "mandatory" hold regardless of what the client sends.
    if (PROOF_REQUIRED_METHODS.includes(data.paymentMethod) && (!data.paymentProofKey || !data.paymentProofType)) {
      throw new TransactionError(
        'PAYMENT_PROOF_REQUIRED',
        'A payment proof photo must be captured before a GCash, Maya, or Other sale can be recorded',
        422,
      );
    }

    if (data.discountType === DISCOUNT_TYPE.MANAGER_OVERRIDE) {
      // Architecture doc: manager_override requires supervisor PIN
      // verification, a flow this phase doesn't implement — reject rather
      // than silently applying zero discount under that label.
      throw new TransactionError(
        'DISCOUNT_TYPE_NOT_SUPPORTED',
        'manager_override discounts require supervisor PIN verification, not yet implemented',
        422,
      );
    }
    if (data.discountType === DISCOUNT_TYPE.PROMOTIONAL) {
      throw new TransactionError(
        'DISCOUNT_TYPE_NOT_SUPPORTED',
        'Promotional discounts are not yet implemented. Contact admin.',
        400,
      );
    }
    if ((data.discountType === DISCOUNT_TYPE.PWD || data.discountType === DISCOUNT_TYPE.SENIOR_CITIZEN) && !data.discountIdReference) {
      throw new TransactionError('DISCOUNT_ID_REQUIRED', 'discount_id_reference is required for PWD/Senior Citizen discounts', 422);
    }
    // Task 209.5 — no proof-required policy exists yet for PWD/Senior
    // Citizen discounts (DISCOUNT_PROOF_REQUIREMENT_POLICY_MISSING), so
    // discount_proof_key is accepted and linked when present but never
    // enforced here the way PAYMENT_PROOF_REQUIRED is above. A future
    // settings-driven policy would gate on the same discountType check.
    const isPwdOrSeniorDiscount = data.discountType === DISCOUNT_TYPE.PWD || data.discountType === DISCOUNT_TYPE.SENIOR_CITIZEN;
    const hasDiscountProof = isPwdOrSeniorDiscount && Boolean(data.discountProofKey && data.discountProofType);

    const resolvedItems = await resolveCartItems(data.branchId, data.items);
    const subtotal = round2(resolvedItems.reduce((sum, item) => sum + item.lineTotal, 0));
    const { discountAmount, vatAmount, vatExemptAmount, totalAmount } = computeAmounts(subtotal, resolvedItems, data.discountType);

    let changeGiven: number | null = null;
    if (data.paymentMethod === 'cash') {
      const tendered = data.cashTendered as number;
      if (toCents(tendered) < toCents(totalAmount)) {
        throw new TransactionError('INSUFFICIENT_CASH_TENDERED', `cash_tendered (${tendered}) is less than total_amount (${totalAmount})`, 422);
      }
      changeGiven = round2(tendered - totalAmount);
    }

    const discountCustomerIdEncrypted = data.discountIdReference ? encryptField(data.discountIdReference) : null;
    const discountCustomerIdHash = data.discountIdReference ? hashField(data.discountIdReference) : null;

    // gcash_reference_number/other_reference_note are no longer collected by
    // the POS UI (Task 139) — the gcashReference column is left null for new
    // sales. Kept only as a pass-through for any older/already-queued client
    // payload that still carries one.
    const referenceNote =
      data.paymentMethod === PAYMENT_METHOD.GCASH || data.paymentMethod === PAYMENT_METHOD.MAYA
        ? (data.gcashReferenceNumber ?? null)
        : data.paymentMethod === PAYMENT_METHOD.OTHER
          ? (data.otherReferenceNote ?? null)
          : null;
    const requiresProof = PROOF_REQUIRED_METHODS.includes(data.paymentMethod);

    // Cost is captured at checkout time (current InventoryStock/InventoryItem
    // unit cost) so later COGS reads don't have to re-estimate from
    // possibly-since-changed cost — see lib/cogs.ts.
    const costedItems = await attachCostToDeductionLines(
      data.branchId,
      resolvedItems.flatMap((item) => item.deductionLines),
    );
    let costedLineCursor = 0;
    const costedDeductionLinesByItem = resolvedItems.map((item) => {
      const lines = costedItems.slice(costedLineCursor, costedLineCursor + item.deductionLines.length);
      costedLineCursor += item.deductionLines.length;
      return lines;
    });

    let created: Awaited<ReturnType<typeof transactionsRepository.createTransaction>> | undefined;
    let postCommitEffects: Array<() => Promise<void>> = [];
    let lastError: unknown;
    for (let attempt = 0; attempt < RECEIPT_SEQUENCE_RETRY_LIMIT; attempt++) {
      const receiptNumber = await generateReceiptNumber(branch.code, attempt);
      try {
        const result = await prisma.$transaction(async (tx) => {
          const txCreated = await transactionsRepository.createTransaction(
            {
              branchId: data.branchId,
              shiftId: data.shiftId,
              cashierId: data.cashierId,
              receiptNumber,
              paymentMethod: data.paymentMethod,
              subtotal,
              discountAmount,
              discountType: data.discountType ?? null,
              discountCustomerIdEncrypted,
              discountCustomerIdHash,
              vatAmount,
              vatExemptAmount,
              totalAmount,
              cashTendered: data.paymentMethod === 'cash' ? (data.cashTendered as number) : null,
              changeAmount: changeGiven,
              gcashReference: referenceNote,
              gcashManuallyVerified: null,
              paymentProofKey: requiresProof ? (data.paymentProofKey as string) : null,
              paymentProofType: requiresProof ? (data.paymentProofType as ImageProofType) : null,
              paymentProofUploadedAt: requiresProof ? new Date() : null,
              discountProofKey: hasDiscountProof ? (data.discountProofKey as string) : null,
              discountProofType: hasDiscountProof ? (data.discountProofType as ImageProofType) : null,
              discountProofUploadedAt: hasDiscountProof ? new Date() : null,
              isOfflineTransaction: data.isOfflineTransaction,
              offlineProvisionalNumber: data.offlineProvisionalNumber ?? null,
              items: resolvedItems.map((item, itemIndex) => ({
                id: item.id,
                productId: item.productId,
                productVariantId: item.productVariantId,
                flavorId: item.flavorId,
                productName: item.productName,
                variantName: item.variantName,
                flavorName: item.flavorName,
                unitPrice: item.unitPrice,
                quantity: item.quantity,
                lineTotal: item.lineTotal,
                recipeVersion: item.recipeVersion,
                // Written at creation, not patched in afterward —
                // TransactionItem rows are immutable after creation (CR-004).
                // componentUnitCost/componentCost are additive fields on top
                // of the original {inventoryItemId, quantity, baseUnitId}
                // shape — safe for reverseInventoryForTransaction's
                // 'inventoryItemId' in entry snapshot-shape discrimination.
                deductionSnapshot: (costedDeductionLinesByItem[itemIndex] ?? []).map((line) => ({
                  inventoryItemId: line.inventoryItemId,
                  quantity: line.quantity,
                  baseUnitId: line.baseUnitId,
                  componentUnitCost: line.componentUnitCost,
                  componentCost: line.componentCost,
                })),
                selectedFlavors: item.selectedFlavors,
                selectedOptions: item.selectedOptions,
              })),
            },
            tx,
          );

          const effects = await deductInventoryForSale(
            tx,
            data.branchId,
            txCreated.id,
            resolvedItems.map((item) => ({ lines: item.deductionLines })),
          );

          return { txCreated, effects };
        }, {
          // Explicit, POS-checkout-scoped limits (config/index.ts) — Prisma's
          // un-configured defaults (2s maxWait, 5s timeout) reliably trip
          // P2028 ("Transaction already closed") for a several-component BOM
          // under realistic remote-DB latency, since this callback does a
          // transaction+items insert plus a lock/read/update/movement-insert
          // round trip per BOM component.
          maxWait: config.posTransaction.maxWaitMs,
          timeout: config.posTransaction.timeoutMs,
        });
        created = result.txCreated;
        postCommitEffects = result.effects;
        break;
      } catch (error) {
        lastError = error;
        // P2002 = unique constraint violation on the receipt number — a
        // concurrent sale at this branch claimed the same daily sequence
        // number; retry with a bumped sequence instead of failing the sale.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          continue;
        }
        // P2028 = "Transaction API error: Transaction already closed" —
        // fired when the interactive transaction exceeds maxWait/timeout
        // (e.g. transient remote-DB latency or connection-pool contention).
        // The transaction has already rolled back at this point (Prisma/
        // Postgres guarantee), so no charge was made and no stock moved —
        // surface a distinct, retryable, client-safe error instead of
        // leaking the raw Prisma code/message, while still logging the
        // original code server-side for diagnosis.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028') {
          console.error('POS checkout transaction timed out or was closed early', {
            branchId: data.branchId,
            shiftId: data.shiftId,
            attempt,
            prismaCode: error.code,
            prismaMessage: error.message,
          });
          throw new TransactionError(
            'CHECKOUT_TIMEOUT',
            'The sale could not be completed in time and was not charged. Please try again.',
            503,
          );
        }
        throw error;
      }
    }
    if (!created) {
      throw lastError instanceof Error
        ? lastError
        : new TransactionError('RECEIPT_NUMBER_CONFLICT', 'Could not allocate a unique receipt number', 500);
    }

    for (const effect of postCommitEffects) {
      await effect();
    }

    // CR-012.1 -- shadow BOM deduction comparison. Strictly best-effort and
    // strictly after the legacy deduction/transaction has already committed:
    // fired without `await` so it can never add latency to (or fail) this
    // response, gated on the feature flag so a disabled flag produces zero
    // extra calculation and zero ShadowBomComparison rows, and `.catch()`-
    // guarded so a throw here can never surface as an unhandled rejection or
    // affect the sale in any way. runShadowComparison itself already never
    // throws (every internal failure is caught and persisted as
    // classification ERROR) -- this catch is belt-and-suspenders only.
    // CR-012.1A -- branch rollout gate checked before any shadow work: an
    // excluded branch performs zero shadow queries and zero shadow writes.
    if (isShadowBomDeductionEnabledForBranch(data.branchId)) {
      for (const item of resolvedItems) {
        void shadowBomDeductionService
          .runShadowComparison(created.id, item.id, data.branchId, item.productVariantId, item.quantity)
          .catch((error: unknown) => {
            // Belt-and-suspenders only -- runShadowComparison already never
            // throws. Log safe identifiers only, never the raw error/stack.
            console.error('Shadow BOM comparison failed unexpectedly (non-blocking, sale unaffected)', {
              transactionId: created.id,
              saleLineId: item.id,
              branchId: data.branchId,
              productVariantId: item.productVariantId,
              errorCategory: error instanceof Error ? error.name : 'UnknownError',
            });
          });
      }
    }

    const response = toTransactionResponse(created as TransactionRow);

    await recordAuditLog({
      action: 'TRANSACTION_CREATED',
      entityType: 'transaction',
      entityId: created.id,
      actorId: data.cashierId,
      actorRole: 'cashier',
      branchId: data.branchId,
      afterState: response,
      ipAddress,
    });

    notifyBranch(data.branchId, SOCKET_EVENTS.TRANSACTION_COMPLETED, response);
    notifySuperAdmin(SOCKET_EVENTS.TRANSACTION_COMPLETED, response);

    // shift.cash_sales_total / gcash_sales_total are never persisted
    // mid-shift — Phase 9's withLiveSalesTotals overlay recomputes them from
    // Transaction rows on every read of GET /api/cash/current, so creating
    // this row is the entire "update the shift's running total" step.

    return response;
  },

  /**
   * Reconnect-sync reconciliation endpoint (Phase 20 Task 4 / Architecture
   * doc §Part 10). Processes a device's queued offline sales in one request,
   * strictly in chronological order (client_created_at), each through the
   * exact same createTransaction path a live sale takes — official receipt
   * numbering, VAT/discount calculation, inventory deduction, and audit
   * logging are not duplicated here, only reused. A failed item is recorded
   * in its own result row and does not stop the rest of the batch from
   * syncing, mirroring the frontend queue's existing per-transaction
   * failure handling (lib/offline/sync-queue.ts).
   */
  async syncOfflineTransactions(data: SyncOfflineTransactionsData, ipAddress: string | null) {
    const ordered = [...data.transactions].sort((a, b) => a.clientCreatedAt - b.clientCreatedAt);

    const results: {
      offline_provisional_number: string;
      status: 'synced' | 'failed';
      transaction?: ReturnType<typeof toTransactionResponse>;
      error?: { code: string; message?: string };
    }[] = [];

    for (const item of ordered) {
      try {
        const transaction = await transactionsService.createTransaction(
          {
            branchId: data.branchId,
            shiftId: item.shiftId,
            cashierId: data.cashierId,
            items: item.items,
            paymentMethod: item.paymentMethod,
            discountType: item.discountType,
            discountIdReference: item.discountIdReference,
            discountAmount: item.discountAmount,
            cashTendered: item.cashTendered,
            gcashReferenceNumber: item.gcashReferenceNumber,
            gcashManuallyVerified: item.gcashManuallyVerified,
            isOfflineTransaction: true,
            offlineProvisionalNumber: item.offlineProvisionalNumber,
          },
          ipAddress,
        );
        results.push({ offline_provisional_number: item.offlineProvisionalNumber, status: 'synced', transaction });
      } catch (error) {
        results.push({
          offline_provisional_number: item.offlineProvisionalNumber,
          status: 'failed',
          error: error instanceof TransactionError ? { code: error.code, message: error.message } : { code: 'SYNC_FAILED' },
        });
      }
    }

    const syncedCount = results.filter((r) => r.status === 'synced').length;
    if (syncedCount > 0) {
      await enqueueNotification('offline_transactions_synced', {
        type: 'offline_transactions_synced',
        branchId: data.branchId,
        syncedCount,
      });
    }

    return { results, synced_count: syncedCount };
  },

  async getTransactionById(id: string) {
    const transaction = await transactionsRepository.findTransactionById(id);
    if (!transaction) throw new TransactionError('TRANSACTION_NOT_FOUND', 'Transaction not found', 404);
    return toTransactionResponse(transaction as TransactionRow);
  },

  async listTransactions(filters: TransactionListFilters) {
    const { transactions, total } = await transactionsRepository.listTransactions(filters);
    return {
      transactions: (transactions as TransactionRow[]).map(toTransactionResponse),
      total,
      page: filters.page,
      limit: filters.limit,
    };
  },

  async voidTransaction(id: string, voidReason: string, actor: ActorContext, ipAddress: string | null) {
    const transaction = (await transactionsRepository.findTransactionById(id)) as TransactionRow | null;
    if (!transaction) throw new TransactionError('TRANSACTION_NOT_FOUND', 'Transaction not found', 404);
    if (transaction.status === 'voided') throw new TransactionError('TRANSACTION_ALREADY_VOIDED', 'This transaction has already been voided', 409);
    if (transaction.status === 'refunded') {
      throw new TransactionError('TRANSACTION_ALREADY_REFUNDED', 'This transaction has already been refunded', 409);
    }
    if (transaction.shift && transaction.shift.status !== 'active') {
      throw new TransactionError('SHIFT_CLOSED', 'Cannot void a transaction from a shift that is no longer open', 409);
    }

    const updated = await prisma.$transaction(
      async (tx) => {
        const updatedRow = await transactionsRepository.voidTransaction(id, { voidedById: actor.id, voidReason }, tx);
        await reverseInventoryForTransaction(
          tx,
          transaction.branchId,
          transaction.id,
          (transaction.items ?? []).map((item) => ({
            productVariantId: item.productVariantId,
            flavorId: item.flavorId,
            quantity: item.quantity,
          })),
          'void',
        );
        return updatedRow;
      },
      // Same round-trip shape (and same P2028 exposure — confirmed against a
      // real database) as createTransaction's deduction loop: a lock/read/
      // update/movement-insert cycle per originally-deducted inventory item.
      { maxWait: config.posTransaction.maxWaitMs, timeout: config.posTransaction.timeoutMs },
    );
    const response = toTransactionResponse(updated as TransactionRow);

    // The shift's cash total is never adjusted for a void (cash stays in the
    // drawer, reconciled at shift close) — a voided transaction is itself a
    // fraud signal for Phase 17. Inventory, however, is reversed above so
    // stock reflects that the sale no longer stands.
    await recordAuditLog({
      action: 'VOID_TRANSACTION',
      entityType: 'transaction',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: transaction.branchId,
      beforeState: toTransactionResponse(transaction),
      afterState: response,
      ipAddress,
    });
    triggerFraudScanForBranch(transaction.branchId);

    const voidPayload = {
      transactionId: response.id,
      branchId: response.branch_id,
      voidedBy: actor.id,
      amount: response.total_amount,
      reason: response.void_reason,
    };
    notifyBranch(response.branch_id, SOCKET_EVENTS.VOID_REQUESTED, voidPayload);
    notifySuperAdmin(SOCKET_EVENTS.VOID_REQUESTED, voidPayload);
    // transactionNumber uses response.receipt_number (the real transaction_number/receipt
    // number, per CLAUDE.md — "Same field. Same value everywhere.") rather than
    // response.id (the DB primary key voidPayload above uses under the transactionId
    // key), since the persisted Notification needs the value staff/admins actually
    // recognize a transaction by.
    await enqueueNotification('void_requested', {
      type: 'void_requested',
      branchId: response.branch_id,
      transactionNumber: response.receipt_number,
      requestedByUserId: actor.id,
      amount: response.total_amount,
      reason: response.void_reason,
    });

    return response;
  },

  async refundTransaction(id: string, refundReason: string, actor: ActorContext, ipAddress: string | null) {
    const transaction = (await transactionsRepository.findTransactionById(id)) as TransactionRow | null;
    if (!transaction) throw new TransactionError('TRANSACTION_NOT_FOUND', 'Transaction not found', 404);
    if (transaction.status === 'voided') throw new TransactionError('TRANSACTION_ALREADY_VOIDED', 'This transaction has already been voided', 409);
    if (transaction.status === 'refunded') {
      throw new TransactionError('TRANSACTION_ALREADY_REFUNDED', 'This transaction has already been refunded', 409);
    }

    const updated = await prisma.$transaction(
      async (tx) => {
        const updatedRow = await transactionsRepository.refundTransaction(id, { refundedById: actor.id, refundReason }, tx);
        await reverseInventoryForTransaction(
          tx,
          transaction.branchId,
          transaction.id,
          (transaction.items ?? []).map((item) => ({
            productVariantId: item.productVariantId,
            flavorId: item.flavorId,
            quantity: item.quantity,
          })),
          'refund',
        );
        return updatedRow;
      },
      // Same reasoning as voidTransaction above.
      { maxWait: config.posTransaction.maxWaitMs, timeout: config.posTransaction.timeoutMs },
    );
    const response = toTransactionResponse(updated as TransactionRow);

    await recordAuditLog({
      action: 'REFUND_TRANSACTION',
      entityType: 'transaction',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: transaction.branchId,
      beforeState: toTransactionResponse(transaction),
      afterState: response,
      ipAddress,
    });
    triggerFraudScanForBranch(transaction.branchId);

    const refundPayload = {
      transactionId: response.id,
      branchId: response.branch_id,
      refundedBy: actor.id,
      amount: response.total_amount,
    };
    notifyBranch(response.branch_id, SOCKET_EVENTS.TRANSACTION_REFUNDED, refundPayload);
    notifySuperAdmin(SOCKET_EVENTS.TRANSACTION_REFUNDED, refundPayload);

    return response;
  },

  async markReceiptPrinted(id: string, actor: ActorContext, ipAddress: string | null) {
    const transaction = await transactionsRepository.findTransactionById(id);
    if (!transaction) throw new TransactionError('TRANSACTION_NOT_FOUND', 'Transaction not found', 404);

    await transactionsRepository.markReceiptPrinted(id);

    await recordAuditLog({
      action: 'TRANSACTION_RECEIPT_PRINTED',
      entityType: 'transaction',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: (transaction as TransactionRow).branchId,
      ipAddress,
    });
  },

  /**
   * Architecture doc §Part 8 "Hold orders": max 3 per terminal, 15-min
   * expiry, no supervisor action required. Cart validation reuses the exact
   * same catalog checks as createTransaction (resolveCartItems) — a held
   * order must be resolvable against the live catalog just as much as a
   * completed sale, since it's replayed into a real transaction on release.
   */
  async holdOrder(data: CreateHoldOrderData, ipAddress: string | null) {
    const shift = await cashRepository.findShiftById(data.shiftId);
    if (!shift || shift.branchId !== data.branchId) {
      throw new TransactionError('INVALID_SHIFT', 'shift_id does not belong to branch_id', 422);
    }
    if (shift.status !== 'active') {
      throw new TransactionError('SHIFT_CLOSED', 'Cannot hold an order on a shift that is not open', 409);
    }

    const activeCount = await transactionsRepository.countActiveHoldOrdersForShift(data.shiftId);
    if (activeCount >= HOLD_ORDER_LIMIT_PER_TERMINAL) {
      throw new TransactionError(
        'HOLD_ORDER_LIMIT_REACHED',
        `This terminal already has ${HOLD_ORDER_LIMIT_PER_TERMINAL} held orders — release or let one expire before holding another`,
        409,
      );
    }

    const resolvedItems = await resolveCartItems(data.branchId, data.items);
    const expiresAt = new Date(Date.now() + HOLD_ORDER_EXPIRY_MS);

    const created = await transactionsRepository.createHoldOrder({
      branchId: data.branchId,
      shiftId: data.shiftId,
      cashierId: data.cashierId,
      expiresAt,
      items: resolvedItems,
    });
    const response = toHoldOrderResponse(created as HoldOrderRow);

    await recordAuditLog({
      action: 'HOLD_ORDER_CREATED',
      entityType: 'hold_order',
      entityId: created.id,
      actorId: data.cashierId,
      actorRole: 'cashier',
      branchId: data.branchId,
      afterState: response,
      ipAddress,
    });

    // Fire-and-forget, same reasoning as inventory deduction above: a queue
    // outage must not fail the hold itself — a stuck `held` row with no
    // expiry job is a manageable ops issue, not a data-integrity one.
    try {
      await enqueueHoldOrderExpiry({ holdOrderId: created.id, branchId: data.branchId, shiftId: data.shiftId }, HOLD_ORDER_EXPIRY_MS);
    } catch (error) {
      console.error(`Failed to enqueue expiry for hold order ${created.id}:`, error);
    }

    return response;
  },

  async listHoldOrders(shiftId: string) {
    const holdOrders = await transactionsRepository.listActiveHoldOrdersForShift(shiftId);
    return { hold_orders: (holdOrders as HoldOrderRow[]).map(toHoldOrderResponse) };
  },

  async releaseHoldOrder(id: string, actor: ActorContext, ipAddress: string | null) {
    const holdOrder = (await transactionsRepository.findHoldOrderById(id)) as HoldOrderRow | null;
    if (!holdOrder) throw new TransactionError('HOLD_ORDER_NOT_FOUND', 'Hold order not found', 404);
    if (holdOrder.status !== 'held') {
      throw new TransactionError('HOLD_ORDER_NOT_ACTIVE', `This hold order is already ${holdOrder.status}`, 409);
    }

    const updated = await transactionsRepository.releaseHoldOrder(id);
    const response = toHoldOrderResponse(updated as HoldOrderRow);

    await recordAuditLog({
      action: 'HOLD_ORDER_RELEASED',
      entityType: 'hold_order',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: holdOrder.branchId,
      beforeState: toHoldOrderResponse(holdOrder),
      afterState: response,
      ipAddress,
    });

    return response;
  },
};
