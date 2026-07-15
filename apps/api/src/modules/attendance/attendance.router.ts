import { Router, type NextFunction, type Request, type Response } from 'express';
import { clockInSchema, clockOutSchema, manualOverrideSchema, attendanceQuerySchema } from '@potato-corner/shared';
import { attendanceService } from './attendance.service.js';
import { AttendanceError } from './attendance.types.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOrSupervisor, allRoles, supervisorOnly } from '../../middleware/authorize.js';
import { branchGuard } from '../../middleware/branch-guard.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

function requireUser(req: Request, res: Response): req is Request & { user: NonNullable<Request['user']> } {
  if (!req.user) {
    res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
    return false;
  }
  return true;
}

function handleAttendanceError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof AttendanceError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

function parseListQuery(req: Request, res: Response): { from?: Date; to?: Date; employeeId?: string; page: number; limit: number } | null {
  const parsed = attendanceQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(422).json({
      data: null,
      error: { code: 'VALIDATION_ERROR', fields: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
      meta: null,
    });
    return null;
  }
  return {
    from: parsed.data.from ? new Date(parsed.data.from) : undefined,
    to: parsed.data.to ? new Date(parsed.data.to) : undefined,
    employeeId: parsed.data.employee_id,
    page: parsed.data.page,
    limit: parsed.data.limit,
  };
}

router.post(
  '/clock-in',
  authenticate,
  allRoles,
  branchGuard,
  validate(clockInSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as { employee_id: string; branch_id: string; device_time?: string; gps_lat: number; gps_lng: number };
      const record = await attendanceService.clockIn(
        {
          employeeId: body.employee_id,
          branchId: body.branch_id,
          deviceTime: body.device_time ? new Date(body.device_time) : undefined,
          gpsLat: body.gps_lat,
          gpsLng: body.gps_lng,
        },
        { id: req.user.user_id, role: req.user.role },
      );
      res.status(201).json({ data: record, error: null, meta: null });
    } catch (error) {
      handleAttendanceError(error, res, next);
    }
  },
);

router.post(
  '/clock-out',
  authenticate,
  allRoles,
  branchGuard,
  validate(clockOutSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as {
        employee_id: string;
        branch_id: string;
        device_time?: string;
        gps_lat?: number;
        gps_lng?: number;
        break_minutes?: number;
      };
      const record = await attendanceService.clockOut(
        body.employee_id,
        {
          deviceTime: body.device_time ? new Date(body.device_time) : undefined,
          gpsLat: body.gps_lat,
          gpsLng: body.gps_lng,
          breakMinutes: body.break_minutes,
        },
        { id: req.user.user_id, role: req.user.role },
      );
      res.status(200).json({ data: record, error: null, meta: null });
    } catch (error) {
      handleAttendanceError(error, res, next);
    }
  },
);

router.get(
  '/branch/:branchId',
  authenticate,
  adminOrSupervisor,
  branchGuard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const filters = parseListQuery(req, res);
      if (!filters) return;
      const result = await attendanceService.getByBranch(req.params.branchId as string, filters);
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleAttendanceError(error, res, next);
    }
  },
);

router.get(
  '/employee/:employeeId',
  authenticate,
  adminOrSupervisor,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const filters = parseListQuery(req, res);
      if (!filters) return;
      const result = await attendanceService.getByEmployee(req.params.employeeId as string, filters);
      res.status(200).json({ data: result, error: null, meta: null });
    } catch (error) {
      handleAttendanceError(error, res, next);
    }
  },
);

router.post(
  '/override',
  authenticate,
  supervisorOnly,
  validate(manualOverrideSchema),
  // branchGuard can't run here — the branch is only known once the original
  // record has been fetched by id, same reasoning as cash.router.ts's
  // GET /:shiftId. attendanceService.manualOverride does the branch check
  // inline after loading the record.
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!requireUser(req, res)) return;
      const body = req.body as {
        original_record_id: string;
        correction_reason: string;
        clock_in_server_time?: string;
        clock_out_server_time?: string | null;
        break_minutes?: number;
      };
      const record = await attendanceService.manualOverride(
        body.original_record_id,
        {
          correctionReason: body.correction_reason,
          clockInServerTime: body.clock_in_server_time ? new Date(body.clock_in_server_time) : undefined,
          clockOutServerTime:
            body.clock_out_server_time === undefined ? undefined : body.clock_out_server_time === null ? null : new Date(body.clock_out_server_time),
          breakMinutes: body.break_minutes,
        },
        { id: req.user.user_id, role: req.user.role },
      );
      res.status(201).json({ data: record, error: null, meta: null });
    } catch (error) {
      handleAttendanceError(error, res, next);
    }
  },
);

export { router as attendanceRouter };
