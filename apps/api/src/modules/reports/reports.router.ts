import { Router, type NextFunction, type Request, type Response } from 'express';
import { ExportRequestSchema, ReportFiltersSchema, ROLES, type ExportRequestInput, type ReportType } from '@potato-corner/shared';
import { reportsService } from './reports.service.js';
import { ReportError } from './reports.types.js';
import type { ReportFilters } from './reports.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminOrSupervisor } from '../../middleware/authorize.js';
import { branchGuard } from '../../middleware/branch-guard.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

// Kept in sync with reports.service.ts's own (unexported) SUPER_ADMIN_ONLY_TYPES
// set. Needed here so the export route's inline branch-ownership check can be
// skipped for these two types — they carry no meaningful branch_id (branch
// comparison spans branches; fraud summary is org-wide), and the mandatory
// "branch_id required" guard below would otherwise reject a non-admin's
// request before the service ever gets a chance to return its 403
// FORBIDDEN_REPORT_TYPE for them.
const SUPER_ADMIN_ONLY_REPORT_TYPES = new Set<ReportType>(['FRAUD_ALERT_SUMMARY', 'BRANCH_COMPARISON', 'AUDIT_LOG']);

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function handleReportError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ReportError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

function toBoundaryDate(value: string | undefined, boundary: 'start' | 'end'): Date | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T${boundary === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`);
  return new Date(value);
}

function parseFilters(query: unknown): { ok: true; filters: ReportFilters } | { ok: false; issues: Array<{ field: string; message: string }> } {
  const parsed = ReportFiltersSchema.safeParse(query);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) };
  return {
    ok: true,
    filters: {
      branchId: parsed.data.branch_id,
      dateFrom: toBoundaryDate(parsed.data.date_from, 'start'),
      dateTo: toBoundaryDate(parsed.data.date_to, 'end'),
      page: parsed.data.page,
      limit: parsed.data.limit,
    },
  };
}

// ---------- Real-time reports (7): both roles, branchGuard applied ----------

function realtimeRoute(path: string, handler: (filters: ReportFilters, actorId: string, actorRole: string) => Promise<unknown>): void {
  router.get(path, authenticate, adminOrSupervisor, requirePasswordChange, branchGuard, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const result = parseFilters(req.query);
      if (!result.ok) {
        res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR', fields: result.issues }, meta: null });
        return;
      }
      const data = await handler(result.filters, req.user.user_id, req.user.role);
      res.status(200).json({ data, error: null, meta: null });
    } catch (error) {
      handleReportError(error, res, next);
    }
  });
}

realtimeRoute('/daily-sales', (f, id, role) => reportsService.getDailySalesReport(f, id, role));
realtimeRoute('/shift-summary', (f, id, role) => reportsService.getShiftSummaryReport(f, id, role));
realtimeRoute('/cash-reconciliation', (f, id, role) => reportsService.getCashReconciliationReport(f, id, role));
realtimeRoute('/void-refund', (f, id, role) => reportsService.getVoidRefundReport(f, id, role));
realtimeRoute('/discount-compliance', (f, id, role) => reportsService.getDiscountComplianceReport(f, id, role));
realtimeRoute('/inventory-movement', (f, id, role) => reportsService.getInventoryMovementReport(f, id, role));
realtimeRoute('/attendance-summary', (f, id, role) => reportsService.getAttendanceSummaryReport(f, id, role));

// ---------- Fraud Alert Summary (real-time, super_admin only, no branchGuard) ----------

router.get('/fraud-alert-summary', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const result = parseFilters(req.query);
    if (!result.ok) {
      res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR', fields: result.issues }, meta: null });
      return;
    }
    const data = await reportsService.getFraudAlertSummaryReport(result.filters, req.user.user_id, req.user.role);
    res.status(200).json({ data, error: null, meta: null });
  } catch (error) {
    handleReportError(error, res, next);
  }
});

// ---------- Audit Log (real-time, super_admin only, no branchGuard) ----------

router.get('/audit-log', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const result = parseFilters(req.query);
    if (!result.ok) {
      res.status(422).json({ data: null, error: { code: 'VALIDATION_ERROR', fields: result.issues }, meta: null });
      return;
    }
    const data = await reportsService.getAuditLogReport(result.filters, req.user.user_id, req.user.role);
    res.status(200).json({ data, error: null, meta: null });
  } catch (error) {
    handleReportError(error, res, next);
  }
});

// ---------- Pre-computed reports (4): both roles, branchGuard applied ----------

function precomputedRoute(path: string, handler: (branchId: string | null, actorId: string, actorRole: string) => Promise<unknown>): void {
  router.get(path, authenticate, adminOrSupervisor, requirePasswordChange, branchGuard, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const branchId = typeof req.query.branch_id === 'string' ? req.query.branch_id : null;
      const data = await handler(branchId, req.user.user_id, req.user.role);
      res.status(200).json({ data, error: null, meta: null });
    } catch (error) {
      handleReportError(error, res, next);
    }
  });
}

precomputedRoute('/product-performance', (b, id, role) => reportsService.getProductPerformanceReport(b, id, role));
precomputedRoute('/flavor-performance', (b, id, role) => reportsService.getFlavorPerformanceReport(b, id, role));
precomputedRoute('/employee-performance', (b, id, role) => reportsService.getEmployeePerformanceReport(b, id, role));
precomputedRoute('/inventory-valuation', (b, id, role) => reportsService.getInventoryValuationReport(b, id, role));

// ---------- Branch Comparison (pre-computed, super_admin only, no branchGuard) ----------

router.get('/branch-comparison', authenticate, adminOnly, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const branchId = typeof req.query.branch_id === 'string' ? req.query.branch_id : null;
    const data = await reportsService.getBranchComparisonReport(branchId, req.user.user_id, req.user.role);
    res.status(200).json({ data, error: null, meta: null });
  } catch (error) {
    handleReportError(error, res, next);
  }
});

// ---------- Export ----------
//
// branchGuard is intentionally NOT used here: its extractBranchId() only
// reads a top-level req.body.branch_id, but this endpoint's body nests
// branch_id under `filters`. The same allow/deny rule is applied inline
// instead, reading `body.filters.branch_id` — mirroring the existing
// precedent in inventory.router.ts for routes branchGuard can't cover.
router.post('/export', authenticate, adminOrSupervisor, requirePasswordChange, validate(ExportRequestSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const body = req.body as ExportRequestInput;

    if (req.user.role !== ROLES.SUPER_ADMIN && !SUPER_ADMIN_ONLY_REPORT_TYPES.has(body.report_type)) {
      const branchId = body.filters.branch_id;
      if (!branchId) {
        res.status(400).json({ data: null, error: { code: 'BRANCH_ID_REQUIRED' }, meta: null });
        return;
      }
      if (!req.user.branch_ids.includes(branchId)) {
        res.status(403).json({ data: null, error: { code: 'BRANCH_ACCESS_DENIED' }, meta: null });
        return;
      }
    }

    const filters: ReportFilters = {
      branchId: body.filters.branch_id,
      dateFrom: toBoundaryDate(body.filters.date_from, 'start'),
      dateTo: toBoundaryDate(body.filters.date_to, 'end'),
      page: body.filters.page,
      limit: body.filters.limit,
    };
    const branchId = filters.branchId ?? null;
    const result = await reportsService.requestExport(body.report_type as ReportType, filters, body.format, req.user.user_id, req.user.role, branchId);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleReportError(error, res, next);
  }
});

export { router as reportsRouter };
