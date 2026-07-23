import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createEmployeeSchema,
  updateEmployeeSchema,
  deactivateEmployeeSchema,
  resetEmployeePasswordSchema,
  ROLES,
  EMPLOYMENT_TYPE,
  type EmploymentType,
  type Role,
} from '@potato-corner/shared';
import { employeesService } from './employees.service.js';
import { EmployeeError } from './employees.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly, adminOrSupervisor, supervisorOnly } from '../../middleware/authorize.js';
import { requirePasswordChange } from '../../middleware/require-password-change.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

const roleValues = Object.values(ROLES) as [Role, ...Role[]];
const employmentTypeValues = Object.values(EMPLOYMENT_TYPE) as [EmploymentType, ...EmploymentType[]];

/** "true"/"false" only — z.coerce.boolean() would treat the literal string "false" as truthy. */
const booleanQueryParam = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

const listQuerySchema = z.object({
  role: z.enum(roleValues).optional(),
  employment_type: z.enum(employmentTypeValues).optional(),
  is_active: booleanQueryParam,
  branch_id: z.uuid().optional(),
  search: z.string().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

/** Routes EmployeeError to its declared status code; unexpected errors fall through to the global handler. */
function handleEmployeeError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof EmployeeError) {
    res
      .status(error.statusCode)
      .json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

router.get('/', authenticate, adminOrSupervisor, requirePasswordChange, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!requireUser(req, res)) return;
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        data: null,
        error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
        meta: null,
      });
      return;
    }
    const result = await employeesService.getAllEmployees(req.user, {
      role: parsed.data.role,
      employmentType: parsed.data.employment_type,
      isActive: parsed.data.is_active,
      branchId: parsed.data.branch_id,
      search: parsed.data.search,
      page: parsed.data.page,
      limit: parsed.data.limit,
    });
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleEmployeeError(error, res, next);
  }
});

router.get(
  '/:employeeId',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const employee = await employeesService.getEmployeeById(req.params.employeeId as string, req.user);
      res.status(200).json({ data: employee, error: null, meta: null });
    } catch (error) {
      handleEmployeeError(error, res, next);
    }
  },
);

router.get(
  '/:employeeId/payroll',
  authenticate,
  adminOnly,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const payroll = await employeesService.getEmployeePayrollData(req.params.employeeId as string, req.user, req.ip ?? null);
      res.status(200).json({ data: payroll, error: null, meta: null });
    } catch (error) {
      handleEmployeeError(error, res, next);
    }
  },
);

router.get(
  '/:employeeId/activity',
  authenticate,
  adminOrSupervisor,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const activity = await employeesService.getEmployeeActivity(req.params.employeeId as string, req.user);
      res.status(200).json({ data: activity, error: null, meta: null });
    } catch (error) {
      handleEmployeeError(error, res, next);
    }
  },
);

router.post(
  '/',
  authenticate,
  supervisorOnly,
  requirePasswordChange,
  validate(createEmployeeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const employee = await employeesService.createEmployee(req.body, req.user, req.ip ?? null);
      res.status(201).json({ data: employee, error: null, meta: null });
    } catch (error) {
      handleEmployeeError(error, res, next);
    }
  },
);

router.patch(
  '/:employeeId',
  authenticate,
  supervisorOnly,
  requirePasswordChange,
  validate(updateEmployeeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const employee = await employeesService.updateEmployee(req.params.employeeId as string, req.body, req.user, req.ip ?? null);
      res.status(200).json({ data: employee, error: null, meta: null });
    } catch (error) {
      handleEmployeeError(error, res, next);
    }
  },
);

router.post(
  '/:employeeId/deactivate',
  authenticate,
  supervisorOnly,
  requirePasswordChange,
  validate(deactivateEmployeeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const employee = await employeesService.deactivateEmployee(
        req.params.employeeId as string,
        req.body,
        req.user,
        req.ip ?? null,
      );
      res.status(200).json({ data: employee, error: null, meta: null });
    } catch (error) {
      handleEmployeeError(error, res, next);
    }
  },
);

router.post(
  '/:employeeId/reactivate',
  authenticate,
  supervisorOnly,
  requirePasswordChange,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const employee = await employeesService.reactivateEmployee(req.params.employeeId as string, req.user, req.ip ?? null);
      res.status(200).json({ data: employee, error: null, meta: null });
    } catch (error) {
      handleEmployeeError(error, res, next);
    }
  },
);

router.post(
  '/:employeeId/reset-password',
  authenticate,
  supervisorOnly,
  requirePasswordChange,
  validate(resetEmployeePasswordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const { new_password } = req.body as { new_password: string };
      await employeesService.resetEmployeePassword(req.params.employeeId as string, new_password, req.user, req.ip ?? null);
      res.status(200).json({ data: { success: true }, error: null, meta: null });
    } catch (error) {
      handleEmployeeError(error, res, next);
    }
  },
);

export { router as employeesRouter };
