import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import {
  createTransactionSchema,
  voidTransactionRequestSchema,
  refundTransactionRequestSchema,
  transactionListQuerySchema,
  discountAuditQuerySchema,
  createHoldOrderSchema,
  syncOfflineTransactionsSchema,
  paymentProofUploadRequestSchema,
  discountProofUploadRequestSchema,
  ROLES,
  type CartItem,
  type OfflineTransactionItem,
  type ImageProofType,
  type PaymentMethod,
} from '@potato-corner/shared';
import { transactionsService } from './transactions.service.js';
import { TransactionError } from './transactions.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOrSupervisor, adminSupervisorOrBranch, allRoles } from '../../middleware/authorize.js';
import { branchGuard } from '../../middleware/branch-guard.js';
import { shiftGuard } from '../../middleware/shift-guard.js';
import { requireActiveEmployee } from '../../middleware/require-active-employee.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';
import { getAccessibleBranchIds, hasBranchAccess } from '../../lib/branch-access.js';

const router: Router = Router();

const paymentProofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      callback(new TransactionError('INVALID_IMAGE_TYPE', 'Image must be JPEG, PNG, or WebP', 422));
      return;
    }
    callback(null, true);
  },
});

/** Task 209.5 — same limits/mime allowlist as paymentProofUpload above, kept as its own multer instance since it backs a separate route/bucket. */
const discountProofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      callback(new TransactionError('INVALID_IMAGE_TYPE', 'Image must be JPEG, PNG, or WebP', 422));
      return;
    }
    callback(null, true);
  },
});

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
  payment_method: PaymentMethod;
  discount_type?: 'pwd' | 'senior_citizen' | 'employee' | 'manager_override' | 'promotional';
  discount_id_reference?: string;
  discount_amount?: number;
  cash_tendered?: number;
  gcash_reference_number?: string;
  gcash_manually_verified?: boolean;
  other_reference_note?: string;
  payment_proof_key?: string;
  payment_proof_type?: ImageProofType;
  discount_proof_key?: string;
  discount_proof_type?: ImageProofType;
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
  requireActiveEmployee,
  requirePasswordChange,
  branchGuard,
  shiftGuard,
  validate(createTransactionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    // Total request-to-response wall time for checkout — deliberately just
    // one number logged around the existing call, not per-stage checkpoints
    // inside transactionsService.createTransaction. That function is the
    // single most financial-critical path in the app (recipe deduction,
    // payment validation, receipt numbering); splicing timing checkpoints
    // through its ~280 lines would risk the exact "altered validation
    // order" the audit warns against for no proven bottleneck. No request
    // body/payment data is logged — branchId only, same as this module's
    // existing console.error calls.
    const checkoutStartedAt = performance.now();
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
          // shiftGuard already resolved the authenticated cashier's own
          // active shift onto req.activeShift (for staff/branch) — trust
          // that over a client-supplied shift_id so checkout can never be
          // pointed at a shift belonging to someone else. Only
          // admin/supervisor (exempt from shiftGuard, so req.activeShift is
          // unset) fall back to the body value.
          shiftId: req.activeShift?.id ?? body.shift_id,
          cashierId: req.user.user_id,
          items: body.items.map((item) => ({
            productId: item.product_id,
            productVariantId: item.product_variant_id,
            flavorId: item.flavor_id,
            selectedFlavors: item.selected_flavors?.map((sf) => ({ slotIndex: sf.slot_index, snackProductVariantId: sf.snack_product_variant_id, flavorId: sf.flavor_id })),
            selectedOptionIds: item.selected_option_ids,
            quantity: item.quantity,
          })),
          paymentMethod: body.payment_method,
          discountType: body.discount_type,
          discountIdReference: body.discount_id_reference,
          discountAmount: body.discount_amount,
          cashTendered: body.cash_tendered,
          gcashReferenceNumber: body.gcash_reference_number,
          gcashManuallyVerified: body.gcash_manually_verified,
          otherReferenceNote: body.other_reference_note,
          paymentProofKey: body.payment_proof_key,
          paymentProofType: body.payment_proof_type,
          discountProofKey: body.discount_proof_key,
          discountProofType: body.discount_proof_type,
          isOfflineTransaction: body.is_offline_transaction,
          offlineProvisionalNumber: body.offline_provisional_number,
        },
        req.ip ?? null,
      );
      // console.warn, not .log — this module's eslint config only allows warn/error.
      console.warn('POS checkout completed', { branchId, durationMs: Math.round(performance.now() - checkoutStartedAt) });
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
  requireActiveEmployee,
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
              selectedFlavors: cartItem.selected_flavors?.map((sf) => ({ slotIndex: sf.slot_index, snackProductVariantId: sf.snack_product_variant_id, flavorId: sf.flavor_id })),
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

// Registered before /:transactionId — same reasoning as /hold below. Multer
// must run before branchGuard/shiftGuard here (unlike the JSON routes above):
// those two middlewares read branch_id/shift_id off req.body via
// extractBranchId, which is only populated once multer finishes parsing the
// multipart payload. validate() runs immediately after multer so the guards
// see the parsed/coerced body, not raw multipart strings.
router.post(
  '/payment-proof',
  authenticate,
  allRoles,
  requireActiveEmployee,
  requirePasswordChange,
  (req: Request, res: Response, next: NextFunction) => {
    paymentProofUpload.single('proof')(req, res, (error: unknown) => {
      if (error) {
        handleModuleError(
          error instanceof multer.MulterError
            ? new TransactionError('IMAGE_TOO_LARGE', 'Image must be 5MB or smaller', 422)
            : error,
          res,
          next,
        );
        return;
      }
      next();
    });
  },
  validate(paymentProofUploadRequestSchema),
  branchGuard,
  shiftGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      if (!req.file) {
        res.status(422).json({ data: null, error: { code: 'IMAGE_REQUIRED', message: 'A payment proof image file is required' }, meta: null });
        return;
      }
      const body = req.body as { branch_id: string; shift_id?: string; type: ImageProofType };
      // Same trust pattern as POST / above — shiftGuard already resolved
      // (and auto-opened, if needed) the authenticated cashier's own active
      // shift onto req.activeShift, so the cashier never needs to have a
      // shift id loaded client-side before capturing payment proof.
      const shiftId = req.activeShift?.id ?? body.shift_id;
      if (!shiftId) {
        res.status(422).json({ data: null, error: { code: 'INVALID_SHIFT', message: 'No active shift could be resolved for this upload' }, meta: null });
        return;
      }
      const result = await transactionsService.uploadPaymentProof(
        { branchId: body.branch_id, shiftId, type: body.type },
        { buffer: req.file.buffer, originalname: req.file.originalname },
        { id: req.user.user_id, role: req.user.role },
      );
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleModuleError(error, res, next);
    }
  },
);

// Task 209.5 — PWD/Senior Citizen discount-proof upload. Same middleware
// order and shift-resolution trust pattern as POST /payment-proof above.
router.post(
  '/discount-proof',
  authenticate,
  allRoles,
  requireActiveEmployee,
  requirePasswordChange,
  (req: Request, res: Response, next: NextFunction) => {
    discountProofUpload.single('proof')(req, res, (error: unknown) => {
      if (error) {
        handleModuleError(
          error instanceof multer.MulterError
            ? new TransactionError('IMAGE_TOO_LARGE', 'Image must be 5MB or smaller', 422)
            : error,
          res,
          next,
        );
        return;
      }
      next();
    });
  },
  validate(discountProofUploadRequestSchema),
  branchGuard,
  shiftGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      if (!req.file) {
        res.status(422).json({ data: null, error: { code: 'IMAGE_REQUIRED', message: 'A discount proof image file is required' }, meta: null });
        return;
      }
      const body = req.body as { branch_id: string; shift_id?: string; type: ImageProofType };
      const shiftId = req.activeShift?.id ?? body.shift_id;
      if (!shiftId) {
        res.status(422).json({ data: null, error: { code: 'INVALID_SHIFT', message: 'No active shift could be resolved for this upload' }, meta: null });
        return;
      }
      const result = await transactionsService.uploadDiscountProof(
        { branchId: body.branch_id, shiftId, type: body.type },
        { buffer: req.file.buffer, originalname: req.file.originalname },
        { id: req.user.user_id, role: req.user.role },
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
  requireActiveEmployee,
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
            selectedFlavors: item.selected_flavors?.map((sf) => ({ slotIndex: sf.slot_index, snackProductVariantId: sf.snack_product_variant_id, flavorId: sf.flavor_id })),
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

router.get('/hold', authenticate, allRoles, requireActiveEmployee, requirePasswordChange, branchGuard, async (req: Request, res: Response, next: NextFunction) => {
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
  requireActiveEmployee,
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

router.get('/', authenticate, allRoles, requireActiveEmployee, requirePasswordChange, branchGuard, async (req: Request, res: Response, next: NextFunction) => {
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
    let branchIds: 'all' | string[];
    if (parsed.data.branch_id) {
      if (!(await hasBranchAccess(req.user, parsed.data.branch_id))) {
        res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
        return;
      }
      branchIds = [parsed.data.branch_id];
    } else {
      branchIds = await getAccessibleBranchIds(req.user);
    }
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

router.get('/:transactionId', authenticate, allRoles, requireActiveEmployee, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const transaction = await transactionsService.getTransactionById(req.params.transactionId as string);
    // branchGuard can't run here — it extracts branch_id from params/query/
    // body, and this route only has a transaction id in the URL. Same inline
    // pattern as GET /ingredients/:id and GET /shifts/:shiftId.
    if (!(await hasBranchAccess(req.user, transaction.branch_id))) {
      res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
      return;
    }
    res.status(200).json({ data: transaction, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.get('/:transactionId/payment-proof', authenticate, allRoles, requireActiveEmployee, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const transaction = await transactionsService.getTransactionById(req.params.transactionId as string);
    // Same inline branch-scope check as GET /:transactionId — branchGuard
    // can't run here, there's only a transaction id in the URL.
    if (!(await hasBranchAccess(req.user, transaction.branch_id))) {
      res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
      return;
    }
    const result = await transactionsService.getPaymentProofUrl(req.params.transactionId as string);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

// Task 209.5 — signed discount-proof URL. Same authorization stack and
// branch-scope check as GET /:transactionId/payment-proof above: any
// authenticated, active employee with access to the transaction's branch
// (the Discount Compliance report's View Proof dialog is the caller).
router.get('/:transactionId/discount-proof', authenticate, allRoles, requireActiveEmployee, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const transaction = await transactionsService.getTransactionById(req.params.transactionId as string);
    if (!(await hasBranchAccess(req.user, transaction.branch_id))) {
      res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
      return;
    }
    const result = await transactionsService.getDiscountProofUrl(req.params.transactionId as string);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleModuleError(error, res, next);
  }
});

router.post(
  '/:transactionId/void',
  authenticate,
  // CR-003: a branch account may approve its own branch's void requests.
  adminSupervisorOrBranch,
  requirePasswordChange,
  validate(voidTransactionRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const transaction = await transactionsService.getTransactionById(req.params.transactionId as string);
      if (!(await hasBranchAccess(req.user, transaction.branch_id))) {
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
  // CR-003: same reasoning as void above — structurally identical
  // branch-scoped exception-approval action, not explicitly named by the
  // task but following the same pattern (judgment call, see report).
  adminSupervisorOrBranch,
  requirePasswordChange,
  validate(refundTransactionRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const transaction = await transactionsService.getTransactionById(req.params.transactionId as string);
      if (!(await hasBranchAccess(req.user, transaction.branch_id))) {
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
  requireActiveEmployee,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const transaction = await transactionsService.getTransactionById(req.params.transactionId as string);
      if (!(await hasBranchAccess(req.user, transaction.branch_id))) {
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
