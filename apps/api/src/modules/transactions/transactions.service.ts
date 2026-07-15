import { Prisma } from '@prisma/client';
import { DISCOUNT_TYPE, SOCKET_EVENTS } from '@potato-corner/shared';
import { transactionsRepository } from './transactions.repository.js';
import { TransactionError, type CartItemInput, type CreateTransactionData, type TransactionListFilters } from './transactions.types.js';
import { cashRepository } from '../cash/cash.repository.js';
import { priceOverridesService } from '../price-overrides/price-overrides.service.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { encryptField } from '../../lib/encryption.js';
import { enqueueSaleDeduction } from '../../queues/inventory.queue.js';
import { notifyBranch, notifySuperAdmin } from '../../lib/notify.js';

type ActorContext = { id: string; role: string };

/** Architecture doc §Discounts — PWD/Senior Citizen VAT formula (Philippine law), locked, never modified without explicit instruction. */
const STATUTORY_DISCOUNT_RATE = 0.2;
/** "Employee (configurable %)" per the architecture doc — no settings model yet, so this constant is the one a future settings feature would read from instead. */
const EMPLOYEE_DISCOUNT_RATE = 0.2;
const VAT_RATE = 0.12;
/** How many bumped-sequence attempts before giving up on a receipt number collision (P2002 on the daily per-branch sequence). */
const RECEIPT_SEQUENCE_RETRY_LIMIT = 5;

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function round2(amount: number): number {
  return toCents(amount) / 100;
}

function isoDateCompact(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
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
    gcash_manually_verified: row.gcashManuallyVerified,
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
    })),
  };
}

interface ResolvedItem {
  productId: string;
  productVariantId: string;
  flavorId: string | null;
  productName: string;
  variantName: string;
  flavorName: string | null;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

/**
 * Resolves and prices every cart line against the live catalog — never
 * trusts a client-submitted price. Rejects the whole transaction if any
 * item references a variant/flavor that isn't active, sellable at this
 * product's global status, or available at this branch (architecture doc
 * §Transaction flow: "unavailable items hidden" applies just as much to
 * what the server accepts as what the client displays).
 */
async function resolveCartItems(branchId: string, items: CartItemInput[]): Promise<ResolvedItem[]> {
  const variantIds = [...new Set(items.map((i) => i.productVariantId))];
  const variants = await transactionsRepository.findVariantsForSale(variantIds);
  const variantMap = new Map(variants.map((v) => [v.id, v]));

  const productIds = [...new Set(variants.map((v) => v.productId))];
  const productAvailability = await transactionsRepository.findBranchProductAvailabilityMap(branchId, productIds);
  const productAvailabilityMap = new Map(productAvailability.map((r) => [r.productId, r.isAvailable]));

  const flavorIds = [...new Set(items.filter((i) => i.flavorId).map((i) => i.flavorId as string))];
  const flavorAvailability = flavorIds.length
    ? await transactionsRepository.findBranchFlavorAvailabilityMap(branchId, flavorIds)
    : [];
  const flavorAvailabilityMap = new Map(flavorAvailability.map((r) => [r.flavorId, r.isAvailable]));

  const resolved: ResolvedItem[] = [];
  for (const item of items) {
    const variant = variantMap.get(item.productVariantId);
    if (!variant || variant.productId !== item.productId) {
      throw new TransactionError('PRODUCT_UNAVAILABLE', `Product variant ${item.productVariantId} is not available for sale`, 422);
    }
    if (!variant.isActive || variant.product.status !== 'active') {
      throw new TransactionError('PRODUCT_UNAVAILABLE', `${variant.product.name} — ${variant.name} is not currently sellable`, 422);
    }
    if (productAvailabilityMap.get(variant.productId) !== true) {
      throw new TransactionError('PRODUCT_UNAVAILABLE', `${variant.product.name} is not available at this branch`, 422);
    }

    let flavorName: string | null = null;
    let pricePremium = 0;
    if (item.flavorId) {
      const link = variant.variantFlavors.find((vf) => vf.flavorId === item.flavorId);
      if (!link || !link.isAvailable || !link.flavor.isActive) {
        throw new TransactionError('PRODUCT_UNAVAILABLE', `Selected flavor is not available for ${variant.name}`, 422);
      }
      if (flavorAvailabilityMap.get(item.flavorId) === false) {
        throw new TransactionError('PRODUCT_UNAVAILABLE', 'Selected flavor is not available at this branch', 422);
      }
      flavorName = link.flavor.name;
      pricePremium = link.pricePremium.toNumber();
    }

    const basePrice = await priceOverridesService.getActivePriceForBranch(branchId, variant.id, variant.basePrice.toNumber());
    const unitPrice = round2(basePrice + pricePremium);
    const lineTotal = round2(unitPrice * item.quantity);

    resolved.push({
      productId: variant.productId,
      productVariantId: variant.id,
      flavorId: item.flavorId ?? null,
      productName: variant.product.name,
      variantName: variant.name,
      flavorName,
      unitPrice,
      quantity: item.quantity,
      lineTotal,
    });
  }
  return resolved;
}

interface ComputedAmounts {
  discountAmount: number;
  vatAmount: number;
  vatExemptAmount: number;
  totalAmount: number;
}

/**
 * VAT + discount calculation. PWD/Senior Citizen follows the architecture
 * doc's locked 5-step formula exactly (see the constants above) — that
 * formula still charges VAT on the discounted base, it does not exempt the
 * sale from VAT, despite what a "vat_exempt_amount" field name might
 * suggest; see the module's ambiguity note in the Phase 10 report. Every
 * other discount type (or none) uses the general VAT-inclusive-pricing
 * extraction: the VAT component is embedded in the post-discount total, not
 * added on top of it.
 */
function computeAmounts(
  subtotal: number,
  discountType: CreateTransactionData['discountType'],
  requestedDiscountAmount: number | undefined,
): ComputedAmounts {
  if (discountType === DISCOUNT_TYPE.PWD || discountType === DISCOUNT_TYPE.SENIOR_CITIZEN) {
    const vatableBase = subtotal / 1.12;
    const discountAmount = round2(vatableBase * STATUTORY_DISCOUNT_RATE);
    const discountedBase = round2(vatableBase - discountAmount);
    const vatAmount = round2(discountedBase * VAT_RATE);
    const totalAmount = round2(discountedBase + vatAmount);
    return { discountAmount, vatAmount, vatExemptAmount: 0, totalAmount };
  }

  let discountAmount = 0;
  if (discountType === DISCOUNT_TYPE.EMPLOYEE) {
    discountAmount = round2(subtotal * EMPLOYEE_DISCOUNT_RATE);
  } else if (discountType === DISCOUNT_TYPE.PROMOTIONAL) {
    discountAmount = round2(requestedDiscountAmount ?? 0);
  }
  const totalAfterDiscount = round2(subtotal - discountAmount);
  const vatAmount = round2(totalAfterDiscount * (12 / 112));
  return { discountAmount, vatAmount, vatExemptAmount: 0, totalAmount: totalAfterDiscount };
}

async function generateReceiptNumber(branchCode: string, attempt: number): Promise<string> {
  const prefix = `${branchCode}-${isoDateCompact(new Date())}-`;
  const count = await transactionsRepository.countTransactionsWithPrefix(prefix);
  const sequence = count + 1 + attempt;
  return `${prefix}${String(sequence).padStart(6, '0')}`;
}

export const transactionsService = {
  async createTransaction(data: CreateTransactionData, ipAddress: string | null) {
    const branch = await transactionsRepository.findBranch(data.branchId);
    if (!branch) throw new TransactionError('INVALID_SHIFT', 'branch_id does not reference a known branch', 422);

    const shift = await cashRepository.findShiftById(data.shiftId);
    if (!shift || shift.branchId !== data.branchId) {
      throw new TransactionError('INVALID_SHIFT', 'shift_id does not belong to branch_id', 422);
    }
    if (shift.status !== 'active') {
      throw new TransactionError('SHIFT_CLOSED', 'Cannot record a transaction on a shift that is not open', 409);
    }

    // Presence of cash_tendered (for cash) / gcash_reference_number (for
    // gcash) is already guaranteed by createTransactionSchema's superRefine
    // — only the business-logic checks below belong here.
    if (data.paymentMethod === 'gcash' && data.gcashManuallyVerified !== true) {
      throw new TransactionError(
        'GCASH_NOT_VERIFIED',
        'GCash payments must be manually verified before the transaction can be recorded',
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
    if ((data.discountType === DISCOUNT_TYPE.PWD || data.discountType === DISCOUNT_TYPE.SENIOR_CITIZEN) && !data.discountIdReference) {
      throw new TransactionError('DISCOUNT_ID_REQUIRED', 'discount_id_reference is required for PWD/Senior Citizen discounts', 422);
    }

    const resolvedItems = await resolveCartItems(data.branchId, data.items);
    const subtotal = round2(resolvedItems.reduce((sum, item) => sum + item.lineTotal, 0));
    const { discountAmount, vatAmount, vatExemptAmount, totalAmount } = computeAmounts(subtotal, data.discountType, data.discountAmount);

    let changeGiven: number | null = null;
    if (data.paymentMethod === 'cash') {
      const tendered = data.cashTendered as number;
      if (toCents(tendered) < toCents(totalAmount)) {
        throw new TransactionError('INSUFFICIENT_CASH_TENDERED', `cash_tendered (${tendered}) is less than total_amount (${totalAmount})`, 422);
      }
      changeGiven = round2(tendered - totalAmount);
    }

    const discountCustomerIdEncrypted = data.discountIdReference ? encryptField(data.discountIdReference) : null;

    let created: Awaited<ReturnType<typeof transactionsRepository.createTransaction>> | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < RECEIPT_SEQUENCE_RETRY_LIMIT; attempt++) {
      const receiptNumber = await generateReceiptNumber(branch.code, attempt);
      try {
        created = await transactionsRepository.createTransaction({
          branchId: data.branchId,
          shiftId: data.shiftId,
          cashierId: data.cashierId,
          receiptNumber,
          paymentMethod: data.paymentMethod,
          subtotal,
          discountAmount,
          discountType: data.discountType ?? null,
          discountCustomerIdEncrypted,
          vatAmount,
          vatExemptAmount,
          totalAmount,
          cashTendered: data.paymentMethod === 'cash' ? (data.cashTendered as number) : null,
          changeAmount: changeGiven,
          gcashReference: data.paymentMethod === 'gcash' ? (data.gcashReferenceNumber as string) : null,
          gcashManuallyVerified: data.paymentMethod === 'gcash' ? true : null,
          isOfflineTransaction: data.isOfflineTransaction,
          offlineProvisionalNumber: data.offlineProvisionalNumber ?? null,
          items: resolvedItems,
        });
        break;
      } catch (error) {
        lastError = error;
        // P2002 = unique constraint violation on the receipt number — a
        // concurrent sale at this branch claimed the same daily sequence
        // number; retry with a bumped sequence instead of failing the sale.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          continue;
        }
        throw error;
      }
    }
    if (!created) {
      throw lastError instanceof Error
        ? lastError
        : new TransactionError('RECEIPT_NUMBER_CONFLICT', 'Could not allocate a unique receipt number', 500);
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

    // Phase 8's inventory deduction queue — dead code until this exact call
    // activates it. Fire-and-forget: a queue outage must not roll back an
    // already-committed sale; BullMQ's own retry policy (10s/60s/300s,
    // see queues/inventory.queue.ts) covers transient failures.
    try {
      await enqueueSaleDeduction({
        transactionId: created.id,
        branchId: data.branchId,
        items: resolvedItems.map((item) => ({
          productVariantId: item.productVariantId,
          flavorId: item.flavorId,
          quantity: item.quantity,
        })),
      });
    } catch (error) {
      console.error(`Failed to enqueue inventory deduction for transaction ${created.id}:`, error);
    }

    // shift.cash_sales_total / gcash_sales_total are never persisted
    // mid-shift — Phase 9's withLiveSalesTotals overlay recomputes them from
    // Transaction rows on every read of GET /api/cash/current, so creating
    // this row is the entire "update the shift's running total" step.

    return response;
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

    const updated = await transactionsRepository.voidTransaction(id, { voidedById: actor.id, voidReason });
    const response = toTransactionResponse(updated as TransactionRow);

    // Deliberate: inventory deduction is never reversed and the shift's cash
    // total is never adjusted (cash stays in the drawer, reconciled at shift
    // close) — a voided transaction is itself a fraud signal for Phase 17,
    // not something to be quietly undone.
    await recordAuditLog({
      action: 'TRANSACTION_VOIDED',
      entityType: 'transaction',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: transaction.branchId,
      beforeState: toTransactionResponse(transaction),
      afterState: response,
      ipAddress,
    });

    const voidPayload = {
      transactionId: response.id,
      branchId: response.branch_id,
      voidedBy: actor.id,
      amount: response.total_amount,
      reason: response.void_reason,
    };
    notifyBranch(response.branch_id, SOCKET_EVENTS.VOID_REQUESTED, voidPayload);
    notifySuperAdmin(SOCKET_EVENTS.VOID_REQUESTED, voidPayload);

    return response;
  },

  async refundTransaction(id: string, refundReason: string, actor: ActorContext, ipAddress: string | null) {
    const transaction = (await transactionsRepository.findTransactionById(id)) as TransactionRow | null;
    if (!transaction) throw new TransactionError('TRANSACTION_NOT_FOUND', 'Transaction not found', 404);
    if (transaction.status === 'voided') throw new TransactionError('TRANSACTION_ALREADY_VOIDED', 'This transaction has already been voided', 409);
    if (transaction.status === 'refunded') {
      throw new TransactionError('TRANSACTION_ALREADY_REFUNDED', 'This transaction has already been refunded', 409);
    }

    const updated = await transactionsRepository.refundTransaction(id, { refundedById: actor.id, refundReason });
    const response = toTransactionResponse(updated as TransactionRow);

    await recordAuditLog({
      action: 'TRANSACTION_REFUNDED',
      entityType: 'transaction',
      entityId: id,
      actorId: actor.id,
      actorRole: actor.role,
      branchId: transaction.branchId,
      beforeState: toTransactionResponse(transaction),
      afterState: response,
      ipAddress,
    });

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
};
