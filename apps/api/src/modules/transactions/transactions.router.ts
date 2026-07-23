import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  createTransactionSchema,
  voidTransactionRequestSchema,
  refundTransactionRequestSchema,
  transactionListQuerySchema,
  discountAuditQuerySchema,
  createHoldOrderSchema,
  syncOfflineTransactionsSchema,
  ROLES,
  type CartItem,
  type OfflineTransactionItem,
} from '@potato-corner/shared';
import { transactionsService } from './transactions.service.js';
import { TransactionError } from './transactions.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOrSupervisor, allRoles } from '../../middleware/authorize.js';
import { branchGuard } from '../../middleware/branch-guard.js';
import { shiftGuard } from '../../middleware/shift-guard.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function handleModuleError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof TransactionError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

interface CreateTransactionBody {
  branch_id: string;
  shift_id: string;
  items: CartItem[];
  payment_method: 'cash' | 'gcash';
  discount_type?: 'pwd' | 'senior_citizen' | 'employee' | 'manager_override' | 'promotional';
  discount_id_reference?: string;
  discount_amount?: number;
  cash_tendered?: number;
  gcash_reference_number?: string;
  gcash_manually_verified?: boolean;
  is_offline_transaction: boolean;
  offline_provisional_number?: string;
}

// authenticate -> authorize -> requirePasswordChange -> branchGuard -> shiftGuard -> validate -> handler.
// shiftGuard was implemented in Phase 2 but never mounted on a real route
// until this one — this is the activation point (staff must have an active
// shift; supervisor/super_admin are exempt, per shift-guard.ts).
router.post(
  '/',
  authenticate,
  allRoles,
  requirePasswordChange,
  branchGuard,
  shiftGuard,
  validate(createTransactionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as CreateTransactionBody;
      // Staff tokens pin exactly one branch_id — use it, never the client body.
      // jwtPayloadSchema requires staff branch_ids to have length 1, but guard
      // defensively rather than asserting non-null.
      let branchId: string;
      if (req.user.role === ROLES.STAFF) {
        const staffBranchId = req.user.branch_ids[0];
        if (!staffBranchId) {
          res.status(403).json({ data: null, error: { code: 'BRANCH_NOT_ASSIGNED' }, meta: null });
          return;
        }
        branchId = staffBranchId;
      } else {
        branchId = body.branch_id;
      }
      const transaction = await transactionsService.createTransaction(
        {
          branchId,
          shiftId: body.shift_id,
          cashierId: req.user.user_id,
          items: body.items.map((item) => ({
            productId: item.product_id,
            productVariantId: item.product_variant_id,
            flavorId: item.flavor_id,
            quantity: item.quantity,
          })),
          paymentMethod: body.payment_method,
          discountType: body.discount_type,
          discountIdReference: body.discount_id_reference,
          discountAmount: body.discount_amount,
          cashTendered: body.cash_tendered,
          gcashReferenceNumber: body.gcash_reference_number,
          gcashManuallyVerified: body.gcash_manually_verified,
          isOfflineTransaction: body.is_offline_transaction,
          offlineProvisionalNumber: body.offline_provisional_number,
        },
        req.ip ?? null,
      );
      res.status(201).json({ data: transaction, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

interface SyncOfflineTransactionsBody {
  branch_id: string;
  transactions: OfflineTransactionItem[];
}

// Registered before /:transactionId — same reasoning as /hold above. Phase
// 20 Task 4: reconnect-sync reconciliation endpoint (Architecture doc §Part
// 10). branchGuard/shiftGuard read branch_id off the top-level body field —
// every queued offline transaction in the batch belongs to the same device,
// hence the same branch and (for staff) the same currently-active shift.
router.post(
  '/sync-offline',
  authenticate,
  allRoles,
  requirePasswordChange,
  branchGuard,
  shiftGuard,
  validate(syncOfflineTransactionsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as SyncOfflineTransactionsBody;
      const result = await transactionsService.syncOfflineTransactions(
        {
          branchId: body.branch_id,
          cashierId: req.user.user_id,
          transactions: body.transactions.map((item) => ({
            offlineProvisionalNumber: item.offline_provisional_number,
            shiftId: item.shift_id,
            items: item.items.map((cartItem) => ({
              productId: cartItem.product_id,
              productVariantId: cartItem.product_variant_id,
              flavorId: cartItem.flavor_id,
              quantity: cartItem.quantity,
            })),
            paymentMethod: item.payment_method,
            discountType: item.discount_type,
            discountIdReference: item.discount_id_reference,
            discountAmount: item.discount_amount,
            cashTendered: item.cash_tendered,
            gcashReferenceNumber: item.gcash_reference_number,
            gcashManuallyVerified: item.gcash_manually_verified,
            clientCreatedAt: item.client_created_at,
          })),
        },
        req.ip ?? null,
      );
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

interface CreateHoldOrderBody {
  branch_id: string;
  shift_id: string;
  items: CartItem[];
}

// Registered before /:transactionId — same reasoning as products.router.ts's
// GET /catalog: Express matches routes in order, and "/hold" would otherwise
// be captured as a :transactionId param.
router.post(
  '/hold',
  authenticate,
  allRoles,
  requirePasswordChange,
  branchGuard,
  shiftGuard,
  validate(createHoldOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as CreateHoldOrderBody;
      const holdOrder = await transactionsService.holdOrder(
        {
          branchId: body.branch_id,
          shiftId: body.shift_id,
          cashierId: req.user.user_id,
          items: body.items.map((item) => ({
            productId: item.product_id,
            productVariantId: item.product_variant_id,
            flavorId: item.flavor_id,
            quantity: item.quantity,
          })),
        },
        req.ip ?? null,
      );
      res.status(201).json({ data: holdOrder, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.get('/hold', authenticate, allRoles, requirePasswordChange, branchGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const shiftId = req.query.shift_id as string | undefined;
    if (!shiftId) {
      res.status(400).json({ data: null, error: { code: 'SHIFT_ID_REQUIRED' }, meta: null });
      return;
    }
    const result = await transactionsService.listHoldOrders(shiftId);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/hold/:holdOrderId/release',
  authenticate,
  allRoles,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const released = await transactionsService.releaseHoldOrder(
        req.params.holdOrderId as string,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: released, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.get('/', authenticate, allRoles, requirePasswordChange, branchGuard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = transactionListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        meta: null,
      });
      return;
    }
    const result = await transactionsService.listTransactions({
      branchId: parsed.data.branch_id,
      shiftId: parsed.data.shift_id,
      status: parsed.data.status,
      paymentMethod: parsed.data.payment_method,
      dateFrom: parsed.data.date_from,
      dateTo: parsed.data.date_to,
      page: parsed.data.page,
      limit: parsed.data.limit,
    });
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/discount-audit', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = discountAuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        meta: null,
      });
      return;
    }
    const branchIds = parsed.data.branch_id
      ? [parsed.data.branch_id]
      : req.user.role === ROLES.SUPER_ADMIN
        ? ('all' as const)
        : req.user.branch_ids;
    const result = await transactionsService.getDiscountAuditTrail(
      {
        branchIds,
        discountType: parsed.data.discount_type,
        dateFrom: parsed.data.date_from,
        dateTo: parsed.data.date_to,
        page: parsed.data.page,
        limit: parsed.data.limit,
      },
      { id: req.user.user_id, role: req.user.role },
      req.ip ?? null,
    );
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/:transactionId', authenticate, allRoles, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const transaction = await transactionsService.getTransactionById(req.params.transactionId as string);
    // branchGuard can't run here — it extracts branch_id from params/query/
    // body, and this route only has a transaction id in the URL. Same inline
    // pattern as GET /ingredients/:id and GET /shifts/:shiftId.
    if (req.user.role !== ROLES.SUPER_ADMIN && !req.user.branch_ids.includes(transaction.branch_id)) {
      res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
      return;
    }
    res.status(200).json({ data: transaction, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/:transactionId/void',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  validate(voidTransactionRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const transaction = await transactionsService.getTransactionById(req.params.transactionId as string);
      if (req.user.role !== ROLES.SUPER_ADMIN && !req.user.branch_ids.includes(transaction.branch_id)) {
        res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
        return;
      }
      const body = req.body as { void_reason: string };
      const updated = await transactionsService.voidTransaction(
        req.params.transactionId as string,
        body.void_reason,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: updated, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/:transactionId/refund',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  validate(refundTransactionRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const transaction = await transactionsService.getTransactionById(req.params.transactionId as string);
      if (req.user.role !== ROLES.SUPER_ADMIN && !req.user.branch_ids.includes(transaction.branch_id)) {
        res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
        return;
      }
      const body = req.body as { refund_reason: string };
      const updated = await transactionsService.refundTransaction(
        req.params.transactionId as string,
        body.refund_reason,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: updated, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

router.post(
  '/:transactionId/receipt-printed',
  authenticate,
  allRoles,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const transaction = await transactionsService.getTransactionById(req.params.transactionId as string);
      if (req.user.role !== ROLES.SUPER_ADMIN && !req.user.branch_ids.includes(transaction.branch_id)) {
        res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
        return;
      }
      await transactionsService.markReceiptPrinted(
        req.params.transactionId as string,
        { id: req.user.user_id, role: req.user.role },
        req.ip ?? null,
      );
      res.status(200).json({ data: { success: true }, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

export { router as transactionsRouter };
