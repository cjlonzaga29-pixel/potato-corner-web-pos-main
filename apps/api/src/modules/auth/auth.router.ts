import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  loginSchema,
  refreshSchema,
  changePasswordSchema,
  resetRequestSchema,
  resetPasswordSchema,
  pinSetSchema,
  pinLoginSchema,
  unlockAccountSchema,
} from '@potato-corner/shared';
import { authService } from './auth.service.js';
import { AuthError } from './auth.types.js';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { adminOnly } from '../../middleware/authorize.js';
import { loginLimiter, resetLimiter } from '../../middleware/rate-limiter.js';
import { config } from '../../config/index.js';
import { parseDurationMs } from '../../lib/duration.js';
import { posthog } from '../../lib/posthog.js';

const router: Router = Router();

const REFRESH_COOKIE_NAME = 'refresh_token';
// Must be '/' (not '/api/auth') — apps/web/middleware.ts reads this cookie
// on every page navigation (e.g. /admin/dashboard, /terminal) to decide
// whether the user is logged in. Scoping it to /api/auth meant the browser
// never attached it outside that one path, so every post-login redirect
// bounced straight back to /login.
const REFRESH_COOKIE_PATH = '/';

// Mirrors the just-issued access token (same JWT, unmodified) into an
// HttpOnly cookie purely so apps/web/middleware.ts can read role/expiry
// locally on the next few navigations without hitting POST /api/auth/refresh
// (a 5-query Postgres round trip) on every single click. Not a new trust
// boundary: it's the identical signed token the client already holds in
// memory, just also parked where the server-side middleware can see it.
// Real authorization is unaffected — apps/api's authenticate middleware
// still verifies signature + expiry + revocation on every actual API call.
const ACCESS_HINT_COOKIE_NAME = 'pc_access_hint';
const ACCESS_HINT_COOKIE_PATH = '/';

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: parseDurationMs(config.jwt.refreshTokenTtl),
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
}

function setAccessHintCookie(res: Response, accessToken: string): void {
  res.cookie(ACCESS_HINT_COOKIE_NAME, accessToken, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: ACCESS_HINT_COOKIE_PATH,
    maxAge: parseDurationMs(config.jwt.accessTokenTtl),
  });
}

function clearAccessHintCookie(res: Response): void {
  res.clearCookie(ACCESS_HINT_COOKIE_NAME, { path: ACCESS_HINT_COOKIE_PATH });
}

function getBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

/** Routes AuthError to its declared status code; unexpected errors fall through to the global handler. */
function handleAuthError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof AuthError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message, details: error.details }, meta: null });
    return;
  }
  next(error);
}

router.post('/login', loginLimiter, validate(loginSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, device_id } = req.body as { email: string; password: string; device_id: string };
    const result = await authService.login(email, password, device_id, req.ip ?? null);
    setRefreshCookie(res, result.refreshToken);
    setAccessHintCookie(res, result.access_token);
    posthog.identify({ distinctId: result.user.id, properties: { $set: { role: result.user.role } } });
    posthog.capture({ distinctId: result.user.id, event: 'user_logged_in', properties: { role: result.user.role, device_id } });
    await posthog.flush();
    res.status(200).json({ data: { access_token: result.access_token, user: result.user }, error: null, meta: null });
  } catch (error) {
    handleAuthError(error, res, next);
  }
});

router.post('/refresh', validate(refreshSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshTokenValue = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME];
    if (!refreshTokenValue) {
      res.status(401).json({ data: null, error: { code: 'REFRESH_MISSING' }, meta: null });
      return;
    }
    const { device_id } = req.body as { device_id: string };
    const result = await authService.refreshToken(refreshTokenValue, device_id);
    setRefreshCookie(res, result.refreshToken);
    setAccessHintCookie(res, result.access_token);
    res.status(200).json({ data: { access_token: result.access_token }, error: null, meta: null });
  } catch (error) {
    handleAuthError(error, res, next);
  }
});

router.post('/logout', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accessToken = getBearerToken(req);
    const refreshTokenValue = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME];
    if (accessToken) {
      await authService.logout(accessToken, refreshTokenValue);
    }
    clearRefreshCookie(res);
    clearAccessHintCookie(res);
    if (req.user) {
      posthog.capture({ distinctId: req.user.user_id, event: 'user_logged_out', properties: { role: req.user.role } });
      await posthog.flush();
    }
    res.status(200).json({ data: { success: true }, error: null, meta: null });
  } catch (error) {
    handleAuthError(error, res, next);
  }
});

router.post('/logout-all', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accessToken = getBearerToken(req);
    if (accessToken && req.user) {
      await authService.logoutAllDevices(req.user.user_id, accessToken);
    }
    clearRefreshCookie(res);
    clearAccessHintCookie(res);
    res.status(200).json({ data: { success: true }, error: null, meta: null });
  } catch (error) {
    handleAuthError(error, res, next);
  }
});

router.post(
  '/change-password',
  authenticate,
  validate(changePasswordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const accessToken = getBearerToken(req);
      const deviceId = req.headers['x-device-id'];
      const { current_password, new_password } = req.body as { current_password: string; new_password: string };
      if (!req.user || !accessToken) {
        res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
        return;
      }
      if (typeof deviceId !== 'string') {
        res.status(400).json({ data: null, error: { code: 'DEVICE_ID_MISSING' }, meta: null });
        return;
      }
      const result = await authService.changePassword(req.user.user_id, current_password, new_password, accessToken, deviceId);
      setRefreshCookie(res, result.refreshToken);
      setAccessHintCookie(res, result.access_token);
      posthog.capture({ distinctId: req.user.user_id, event: 'password_changed', properties: { role: req.user.role } });
      await posthog.flush();
      res.status(200).json({ data: { access_token: result.access_token, user: result.user }, error: null, meta: null });
    } catch (error) {
      handleAuthError(error, res, next);
    }
  },
);

router.post(
  '/request-reset',
  resetLimiter,
  validate(resetRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body as { email: string };
      await authService.requestPasswordReset(email);
      // Same response whether or not the email exists — never confirm account existence.
      res.status(200).json({
        data: { message: 'If an account exists for that email, a reset link has been sent.' },
        error: null,
        meta: null,
      });
    } catch (error) {
      handleAuthError(error, res, next);
    }
  },
);

router.post(
  '/reset-password',
  validate(resetPasswordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token, new_password } = req.body as { token: string; new_password: string };
      await authService.resetPassword(token, new_password);
      res.status(200).json({ data: { success: true }, error: null, meta: null });
    } catch (error) {
      handleAuthError(error, res, next);
    }
  },
);

router.post('/pin/set', authenticate, validate(pinSetSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deviceId = req.headers['x-device-id'];
    if (!req.user || typeof deviceId !== 'string') {
      res.status(400).json({ data: null, error: { code: 'DEVICE_ID_MISSING' }, meta: null });
      return;
    }
    const { pin } = req.body as { pin: string };
    await authService.setPin(req.user.user_id, deviceId, pin);
    res.status(200).json({ data: { success: true }, error: null, meta: null });
  } catch (error) {
    handleAuthError(error, res, next);
  }
});

router.post('/pin/login', loginLimiter, validate(pinLoginSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { user_id, pin, device_id } = req.body as { user_id: string; pin: string; device_id: string };
    const result = await authService.validatePin(user_id, device_id, pin);
    res.status(200).json({ data: result, error: null, meta: null });
  } catch (error) {
    handleAuthError(error, res, next);
  }
});

router.post(
  '/admin/unlock-account',
  authenticate,
  adminOnly,
  validate(unlockAccountSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        res.status(401).json({ data: null, error: { code: 'TOKEN_MISSING' }, meta: null });
        return;
      }
      const { user_id } = req.body as { user_id: string };
      await authService.unlockAccount(user_id, { id: req.user.user_id, role: req.user.role }, req.ip ?? null);
      res.status(200).json({ data: { message: 'Account unlocked' }, error: null, meta: null });
    } catch (error) {
      handleAuthError(error, res, next);
    }
  },
);

export { router as authRouter };
