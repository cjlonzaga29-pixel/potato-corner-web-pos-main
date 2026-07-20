import { Prisma } from '@prisma/client';
import { DISCOUNT_TYPE, SOCKET_EVENTS } from '@potato-corner/shared';
import { transactionsRepository } from './transactions.repository.js';
import {
  TransactionError,
  HOLD_ORDER_LIMIT_PER_TERMINAL,
  HOLD_ORDER_EXPIRY_MS,
  type CartItemInput,
  type CreateTransactionData,
  type CreateHoldOrderData,
  type TransactionListFilters,
  type SyncOfflineTransactionsData,
} from './transactions.types.js';
import { cashRepository } from '../cash/cash.repository.js';
import { priceOverridesService } from '../price-overrides/price-overrides.service.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { encryptField, hashField } from '../../lib/encryption.js';
import { enqueueSaleDeduction } from '../../queues/inventory.queue.js';
import { enqueueNotification } from '../../queues/notification.queue.js';
import { enqueueHoldOrderExpiry } from '../../queues/hold-order.queue.js';
import { notifyBranch, notifySuperAdmin } from '../../lib/notify.js';

type ActorContext = { id: string; role: string };

/** Architecture doc §Discounts — PWD/Senior Citizen VAT formula (Philippine law), locked, never modified without explicit instruction. */
const STATUTORY_DISCOUNT_RATE = 0.2;
/** "Employee (configurable %)" per the architecture doc — no settings model yet, so this constant is the one a future settings feature would read from instead. */
const EMPLOYEE_DISCOUNT_RATE = 0.2;
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
  productId: string;
  productVariantId: string;
  flavorId: string | null;
  productName: string;
  variantName: string;
  flavorName: string | null;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  vatableCapAmount: number | null;
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
      vatableCapAmount: variant.vatableCapAmount?.toNumber() ?? null,
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
          discountCustomerIdHash,
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
