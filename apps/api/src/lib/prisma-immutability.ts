import type { Prisma } from '@prisma/client';

/**
 * CR-004 — service-level backstop enforcing that InventoryMovement
 * (append-only ledger, per the schema's own doc comment) and Transaction /
 * TransactionItem (sale-time snapshot, per CLAUDE.md's "Critical Business
 * Rules") can never be mutated or removed outside the narrow, explicitly
 * modeled status transitions the repository layer already performs (void,
 * refund, receipt-printed, inventory-deduction-status). This is a backstop,
 * not the primary guard — the repository layer already never calls
 * update/delete on InventoryMovement or TransactionItem at all, and every
 * existing Transaction.update call already hardcodes its own narrow `data`
 * shape (see transactions.repository.ts). It only rejects a future write
 * path that doesn't follow that discipline.
 */
export class ImmutabilityViolationError extends Error {
  constructor(model: string, operation: string) {
    super(`${model}.${operation} is not permitted — ${model} rows are immutable after creation (CR-004)`);
    this.name = 'ImmutabilityViolationError';
  }
}

const BLOCKED_ACTIONS = new Set(['update', 'updateMany', 'delete', 'deleteMany', 'upsert']);

/**
 * The only Transaction columns a repository write is ever allowed to touch
 * after creation — every one of them a status-transition field, never a
 * money/catalog-snapshot field (subtotal, totalAmount, items, etc.).
 */
const TRANSACTION_MUTABLE_FIELDS = new Set([
  'status',
  'voidedAt',
  'voidedById',
  'voidReason',
  'refundedAt',
  'refundedById',
  'refundReason',
  'receiptPrinted',
  'inventoryDeductionStatus',
  'syncedAt',
  'updatedAt',
]);

function assertTransactionUpdateAllowed(operation: string, args: { data?: unknown }): void {
  const data = args.data as Record<string, unknown> | undefined;
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (!TRANSACTION_MUTABLE_FIELDS.has(key)) {
      throw new ImmutabilityViolationError('Transaction', `${operation}(data.${key})`);
    }
  }
}

/**
 * Pure guard, factored out from the extension below so it's unit-testable
 * without spinning up a real Prisma client — see prisma-immutability.test.ts.
 */
export function assertMutableWrite(model: 'InventoryMovement' | 'TransactionItem' | 'Transaction', operation: string, args: { data?: unknown }): void {
  if (model === 'Transaction') {
    if (operation === 'delete' || operation === 'deleteMany') {
      throw new ImmutabilityViolationError(model, operation);
    }
    if (operation === 'update' || operation === 'updateMany' || operation === 'upsert') {
      assertTransactionUpdateAllowed(operation, args);
    }
    return;
  }
  if (BLOCKED_ACTIONS.has(operation)) {
    throw new ImmutabilityViolationError(model, operation);
  }
}

const GUARDED_MODELS = new Set(['InventoryMovement', 'TransactionItem', 'Transaction']);

/**
 * Prisma middleware, not a client extension — deliberately. An extension
 * (`prisma.$extends(...)`) changes the *type* of the exported `prisma`
 * singleton, which broke every repository's `tx?: Prisma.TransactionClient`
 * parameter and `prisma.$transaction(async (tx) => ...)` callback typing
 * project-wide. Middleware (`prisma.$use(...)`) intercepts the exact same
 * operations — including inside `$transaction` callbacks — without altering
 * the client's type at all.
 */
export function immutabilityMiddleware(
  params: Prisma.MiddlewareParams,
  next: (params: Prisma.MiddlewareParams) => Promise<unknown>,
): Promise<unknown> {
  if (params.model && GUARDED_MODELS.has(params.model)) {
    assertMutableWrite(params.model as 'InventoryMovement' | 'TransactionItem' | 'Transaction', params.action, params.args as { data?: unknown });
  }
  return next(params);
}
