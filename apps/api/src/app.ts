import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import * as Sentry from '@sentry/node';
import { config } from './config/index.js';
import { apiLimiter } from './middleware/rate-limiter.js';
import { csrfGuard } from './middleware/csrf-guard.js';

import { authRouter } from './modules/auth/auth.router.js';
import { branchesRouter } from './modules/branches/branches.router.js';
import { productsRouter } from './modules/products/products.router.js';
import { flavorsRouter } from './modules/flavors/flavors.router.js';
import { recipesRouter } from './modules/recipes/recipes.router.js';
import { inventoryRouter, inventoryBranchRouter } from './modules/inventory/inventory.router.js';
import { productRequestsRouter } from './modules/product-requests/product-requests.router.js';
import { inventoryRequestsRouter } from './modules/inventory-requests/inventory-requests.router.js';
import { priceOverridesRouter } from './modules/price-overrides/price-overrides.router.js';
import { transactionsRouter } from './modules/transactions/transactions.router.js';
import { discountsRouter } from './modules/discounts/discounts.router.js';
import { receiptsRouter } from './modules/receipts/receipts.router.js';
import { employeesRouter } from './modules/employees/employees.router.js';
import { attendanceRouter } from './modules/attendance/attendance.router.js';
import { cashRouter } from './modules/cash/cash.router.js';
import { reportsRouter } from './modules/reports/reports.router.js';
import { notificationsRouter } from './modules/notifications/notifications.router.js';
import { auditRouter } from './modules/audit/audit.router.js';
import { fraudRouter } from './modules/fraud/fraud.router.js';
import { expensesRouter } from './modules/expenses/expenses.router.js';
import { settingsRouter, branchReceiptConfigRouter } from './modules/settings/settings.router.js';
import { AuthError } from './modules/auth/auth.types.js';

export const app: Express = express();

// Render puts the app behind exactly one reverse proxy hop — trusting
// only that hop (not `true`, which trusts the whole chain) keeps
// X-Forwarded-For spoofable-client-side while still letting
// express-rate-limit read the real client IP.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: config.frontendUrl, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(morgan(config.isProduction ? 'combined' : 'dev'));

// Liveness check must never depend on Redis (rate limiting's backing
// store) — an uptime monitor or orchestrator's health probe should
// succeed even during a Redis outage, which is exactly the situation
// where you most need to know the API process itself is still up.
app.get('/health', (_req: Request, res: Response) => {
  res.json({ data: { status: 'ok' }, error: null, meta: null });
});

app.use(apiLimiter);

// Double-submit cookie CSRF check for state-changing requests — see
// middleware/csrf-guard.ts for the exemption rationale.
app.use(csrfGuard);

app.use('/api/auth', authRouter);
app.use('/api/branches', branchesRouter);
// Same prefix as branchesRouter — no path collision (branchesRouter owns
// /:branchId and its assignments/status/stats sub-paths; this one only
// matches /:branchId/inventory*), Express tries each mounted router in order.
app.use('/api/branches', inventoryBranchRouter);
app.use('/api/products', productsRouter);
app.use('/api/flavors', flavorsRouter);
app.use('/api/recipes', recipesRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/product-requests', productRequestsRouter);
app.use('/api/inventory-requests', inventoryRequestsRouter);
app.use('/api/price-overrides', priceOverridesRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/discounts', discountsRouter);
app.use('/api/receipts', receiptsRouter);
app.use('/api/employees', employeesRouter);
app.use('/api/attendance', attendanceRouter);
app.use('/api/cash', cashRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/audit', auditRouter);
app.use('/api/fraud', fraudRouter);
app.use('/api/expenses', expensesRouter);
app.use('/api/settings', settingsRouter);
// Same prefix as branchesRouter — no path collision (branchesRouter owns
// /:branchId; this owns /:branchId/receipt-config).
app.use('/api/branches', branchReceiptConfigRouter);

// Express 5 catch-all syntax (path-to-regexp v8) — '*' alone is no longer valid.
app.use('/{*splat}', (_req: Request, res: Response) => {
  res.status(404).json({ data: null, error: { code: 'NOT_FOUND' }, meta: null });
});

// Global error handler — must be registered last, with all four params, for
// Express to recognize it as an error handler rather than a normal route.
app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof AuthError) {
    res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message }, meta: null });
    return;
  }

  Sentry.captureException(error, {
    tags: { path: req.path, method: req.method },
    user: req.user ? { id: req.user.user_id } : undefined,
  });
  console.error('Unhandled error:', error);

  // Never leak internals to the client — generic message only.
  res.status(500).json({ data: null, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' }, meta: null });
});
