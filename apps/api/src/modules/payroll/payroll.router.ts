import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  payRateCreateSchema,
  payRateVoidSchema,
  payrollAdjustmentCreateSchema,
  payrollExportQuerySchema,
  payrollFinalizeSchema,
  payrollMarkPaidSchema,
  payrollPolicyInputSchema,
  payrollResolutionCreateSchema,
  payrollReviseSchema,
  payrollRunCreateSchema,
  payrollRunQuerySchema,
  payrollVoidSchema,
  type JwtPayload,
  type PayRateCreateInput,
  type PayrollAdjustmentCreateInput,
  type PayrollFinalizeInput,
  type PayrollPolicyInput,
  type PayrollResolutionCreateInput,
  type PayrollRunCreateInput,
} from '@potato-corner/shared';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOrSupervisor } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { branchGuard } from '../../middleware/branch-guard.js';
import { validate } from '../../middleware/validate.js';
import { recordAuditLog } from '../../middleware/audit-log.js';
import { payrollService } from './payroll.service.js';
import { PayrollError } from './payroll.types.js';
import { buildPayrollCsv, buildPayrollPdf, payrollExportFilename } from './payroll-export.js';

/**
 * POS-PERF-P52 — /api/payroll. Super Admin (every branch) and Supervisor
 * (current active branch assignments) only; Branch Accounts and staff get
 * 403 from `adminOrSupervisor`. Every route is `/branches/:branchId/...` so
 * `branchGuard` checks the branch before the handler runs, and the service
 * re-checks it and verifies every submitted run/rate/adjustment id belongs
 * to that branch.
 */
const router: Router = Router();
const guard = [authenticate, adminOrSupervisor, requirePasswordChange, branchGuard] as const;

function actor(req: Request): JwtPayload {
  // `authenticate` ran first (see `guard`), so req.user is always set here.
  return req.user as JwtPayload;
}

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

function handle(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof PayrollError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

function queryOr422<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, req: Request, res: Response): T | null {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    res.status(422).json({
      data: null,
      error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
      meta: null,
    });
    return null;
  }
  return parsed.data;
}

router.get('/branches/:branchId/settings', ...guard, async (req, res, next) => {
  try {
    res.json({ data: await payrollService.getSettings(actor(req), param(req, 'branchId')), error: null, meta: null });
  } catch (error) {
    handle(error, res, next);
  }
});

router.put('/branches/:branchId/policy', ...guard, validate(payrollPolicyInputSchema), async (req, res, next) => {
  try {
    const data = await payrollService.savePolicy(actor(req), param(req, 'branchId'), req.body as PayrollPolicyInput);
    res.status(201).json({ data, error: null, meta: null });
  } catch (error) {
    handle(error, res, next);
  }
});

router.get('/branches/:branchId/rates', ...guard, async (req, res, next) => {
  try {
    res.json({ data: await payrollService.listRates(actor(req), param(req, 'branchId')), error: null, meta: null });
  } catch (error) {
    handle(error, res, next);
  }
});

router.post('/branches/:branchId/rates', ...guard, validate(payRateCreateSchema), async (req, res, next) => {
  try {
    const data = await payrollService.createRate(actor(req), param(req, 'branchId'), req.body as PayRateCreateInput);
    res.status(201).json({ data, error: null, meta: null });
  } catch (error) {
    handle(error, res, next);
  }
});

router.post('/branches/:branchId/rates/:rateId/void', ...guard, validate(payRateVoidSchema), async (req, res, next) => {
  try {
    const body = req.body as { reason: string; expected_latest_rate_id: string | null };
    res.json({ data: await payrollService.voidRate(actor(req), param(req, 'branchId'), param(req, 'rateId'), body), error: null, meta: null });
  } catch (error) {
    handle(error, res, next);
  }
});

router.get('/branches/:branchId/periods', ...guard, async (req, res, next) => {
  try {
    res.json({ data: await payrollService.listPeriods(actor(req), param(req, 'branchId')), error: null, meta: null });
  } catch (error) {
    handle(error, res, next);
  }
});

router.post('/branches/:branchId/runs', ...guard, validate(payrollRunCreateSchema), async (req, res, next) => {
  try {
    const result = await payrollService.createRun(actor(req), param(req, 'branchId'), req.body as PayrollRunCreateInput);
    res.status(result.created ? 201 : 200).json({ data: result.run, error: null, meta: { created: result.created } });
  } catch (error) {
    handle(error, res, next);
  }
});

router.get('/branches/:branchId/runs/:runId', ...guard, async (req, res, next) => {
  try {
    const query = queryOr422(payrollRunQuerySchema, req, res);
    if (!query) return;
    const data = await payrollService.getRun(actor(req), param(req, 'branchId'), param(req, 'runId'), query.employee_id);
    res.json({ data, error: null, meta: null });
  } catch (error) {
    handle(error, res, next);
  }
});

router.post('/branches/:branchId/runs/:runId/adjustments', ...guard, validate(payrollAdjustmentCreateSchema), async (req, res, next) => {
  try {
    const data = await payrollService.addAdjustment(actor(req), param(req, 'branchId'), param(req, 'runId'), req.body as PayrollAdjustmentCreateInput);
    res.status(201).json({ data, error: null, meta: null });
  } catch (error) {
    handle(error, res, next);
  }
});

router.post('/branches/:branchId/runs/:runId/adjustments/:adjustmentId/void', ...guard, validate(payrollVoidSchema), async (req, res, next) => {
  try {
    const { reason } = req.body as { reason: string };
    const data = await payrollService.voidAdjustment(actor(req), param(req, 'branchId'), param(req, 'runId'), param(req, 'adjustmentId'), reason);
    res.json({ data, error: null, meta: null });
  } catch (error) {
    handle(error, res, next);
  }
});

router.post('/branches/:branchId/runs/:runId/resolutions', ...guard, validate(payrollResolutionCreateSchema), async (req, res, next) => {
  try {
    const data = await payrollService.addResolution(actor(req), param(req, 'branchId'), param(req, 'runId'), req.body as PayrollResolutionCreateInput);
    res.status(201).json({ data, error: null, meta: null });
  } catch (error) {
    handle(error, res, next);
  }
});

router.post('/branches/:branchId/runs/:runId/finalize', ...guard, validate(payrollFinalizeSchema), async (req, res, next) => {
  try {
    const data = await payrollService.finalize(actor(req), param(req, 'branchId'), param(req, 'runId'), req.body as PayrollFinalizeInput);
    res.json({ data, error: null, meta: null });
  } catch (error) {
    handle(error, res, next);
  }
});

router.post('/branches/:branchId/runs/:runId/discard', ...guard, validate(payrollVoidSchema), async (req, res, next) => {
  try {
    const { reason } = req.body as { reason: string };
    res.json({ data: await payrollService.discard(actor(req), param(req, 'branchId'), param(req, 'runId'), reason), error: null, meta: null });
  } catch (error) {
    handle(error, res, next);
  }
});

router.post('/branches/:branchId/runs/:runId/revise', ...guard, validate(payrollReviseSchema), async (req, res, next) => {
  try {
    const { reason } = req.body as { reason: string };
    res.status(201).json({ data: await payrollService.revise(actor(req), param(req, 'branchId'), param(req, 'runId'), reason), error: null, meta: null });
  } catch (error) {
    handle(error, res, next);
  }
});

router.post('/branches/:branchId/runs/:runId/mark-paid', ...guard, validate(payrollMarkPaidSchema), async (req, res, next) => {
  try {
    const { paid_reference } = req.body as { paid_reference?: string };
    res.json({ data: await payrollService.markPaid(actor(req), param(req, 'branchId'), param(req, 'runId'), paid_reference), error: null, meta: null });
  } catch (error) {
    handle(error, res, next);
  }
});

router.get('/branches/:branchId/runs/:runId/export', ...guard, async (req, res, next) => {
  try {
    const query = queryOr422(payrollExportQuerySchema, req, res);
    if (!query) return;
    const user = actor(req);
    const branchId = param(req, 'branchId');
    const detail = await payrollService.getRun(user, branchId, param(req, 'runId'), query.employee_id);
    const body = query.format === 'csv' ? buildPayrollCsv(detail) : await buildPayrollPdf(detail);
    const filename = payrollExportFilename(detail, query.format);
    void recordAuditLog({
      action: 'PAYROLL_EXPORTED',
      entityType: 'payroll_run',
      entityId: detail.id,
      actorId: user.user_id,
      actorRole: user.role,
      branchId,
      afterState: { format: query.format, status: detail.status, employee_filter: detail.employee_filter, calculated_total: detail.totals.calculated_total },
    });
    res.setHeader('Content-Type', query.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(body);
  } catch (error) {
    handle(error, res, next);
  }
});

export { router as payrollRouter };
