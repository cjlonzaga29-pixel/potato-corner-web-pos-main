import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';

vi.mock('./receipts.service.js', () => ({
  receiptsService: {
    getPublicReceipt: vi.fn(),
  },
}));

const { receiptsService } = await import('./receipts.service.js');
const { ReceiptError } = await import('./receipts.types.js');
const { receiptsRouter } = await import('./receipts.router.js');

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    params: {},
    query: {},
    body: {},
    originalUrl: '/api/receipts/test',
    ip: randomUUID(),
    // express-rate-limit (wired into this route as of Task 209.48) reads
    // req.app.get('trust proxy') to decide how to validate req.ip — same
    // stub used by rate-limiter.test.ts / auth.router.test.ts.
    app: { get: () => false },
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res = {} as Response & { statusCode?: number; jsonBody?: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((body: unknown) => {
    res.jsonBody = body;
    return res;
  }) as unknown as Response['json'];
  res.setHeader = vi.fn(() => res) as unknown as Response['setHeader'];
  res.getHeader = vi.fn(() => undefined) as unknown as Response['getHeader'];
  res.removeHeader = vi.fn(() => res) as unknown as Response['removeHeader'];
  return res;
}

function getRouteHandlers(router: Router, method: string, path: string): Middleware[] {
  type RouteLayer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Middleware }> } };
  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`No route registered for ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

async function runHandlers(handlers: Middleware[], req: Request, res: Response): Promise<void> {
  for (const handler of handlers) {
    let calledNext = false;
    await handler(req, res, (() => {
      calledNext = true;
    }) as NextFunction);
    if (!calledNext) return;
  }
}

const samplePublicReceipt = {
  receipt_number: 'MNL001-20260714-000001',
  branch_name: 'Manila - Robinsons',
  status: 'completed' as const,
  created_at: '2026-07-14T10:00:00.000Z',
  items: [],
  subtotal: 130,
  discount_amount: 0,
  discount_type: null,
  discount_rate_used: null,
  vat_amount: 13.93,
  total_amount: 130,
  payment_method: 'cash',
  cash_tendered: 150,
  change_given: 20,
  gcash_reference_number: null,
};

describe('GET /api/receipts/:transactionNumber', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires no authentication and returns the public receipt', async () => {
    vi.mocked(receiptsService.getPublicReceipt).mockResolvedValue(samplePublicReceipt);

    const req = mockReq({ params: { transactionNumber: 'MNL001-20260714-000001' } });
    const res = mockRes();

    await runHandlers(getRouteHandlers(receiptsRouter, 'get', '/:transactionNumber'), req, res);

    expect(receiptsService.getPublicReceipt).toHaveBeenCalledWith('MNL001-20260714-000001');
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res as unknown as { jsonBody: { data: { receipt_number: string } } }).jsonBody.data.receipt_number).toBe(
      'MNL001-20260714-000001',
    );
  });

  it('returns 404 with RECEIPT_NOT_FOUND when the receipt does not exist', async () => {
    vi.mocked(receiptsService.getPublicReceipt).mockRejectedValue(new ReceiptError('RECEIPT_NOT_FOUND', 'Receipt not found', 404));

    const req = mockReq({ params: { transactionNumber: 'does-not-exist' } });
    const res = mockRes();

    await runHandlers(getRouteHandlers(receiptsRouter, 'get', '/:transactionNumber'), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect((res as unknown as { jsonBody: { error: { code: string } } }).jsonBody.error.code).toBe('RECEIPT_NOT_FOUND');
  });

  it('returns the same 404/RECEIPT_NOT_FOUND shape for a malformed receipt number as for a well-formed but missing one (no oracle)', async () => {
    vi.mocked(receiptsService.getPublicReceipt).mockRejectedValue(new ReceiptError('RECEIPT_NOT_FOUND', 'Receipt not found', 404));

    const req = mockReq({ params: { transactionNumber: "'; DROP TABLE transactions; --" } });
    const res = mockRes();

    await runHandlers(getRouteHandlers(receiptsRouter, 'get', '/:transactionNumber'), req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    const body = (res as unknown as { jsonBody: { data: unknown; error: { code: string; message: string } } }).jsonBody;
    expect(body.data).toBeNull();
    expect(body.error.code).toBe('RECEIPT_NOT_FOUND');
    // No stack trace / DB error text leaking through.
    expect(body.error.message).toBe('Receipt not found');
  });

  it('the public DTO exposes only the approved receipt fields — no internal IDs, employee/cashier identity, proof/storage keys, or customer PII', async () => {
    vi.mocked(receiptsService.getPublicReceipt).mockResolvedValue(samplePublicReceipt);

    const req = mockReq({ params: { transactionNumber: 'MNL001-20260714-000001' } });
    const res = mockRes();

    await runHandlers(getRouteHandlers(receiptsRouter, 'get', '/:transactionNumber'), req, res);

    const data = (res as unknown as { jsonBody: { data: Record<string, unknown> } }).jsonBody.data;
    const forbiddenKeys = [
      'id',
      'transaction_id',
      'branch_id',
      'cashier_id',
      'employee_id',
      'user_id',
      'shift_id',
      'device_id',
      'customer_id',
      'proof_url',
      'proof_key',
      'discount_proof',
      'notes',
      'internal_notes',
    ];
    for (const key of forbiddenKeys) {
      expect(data).not.toHaveProperty(key);
    }
    expect(Object.keys(data).sort()).toEqual(
      [
        'receipt_number',
        'branch_name',
        'status',
        'created_at',
        'items',
        'subtotal',
        'discount_amount',
        'discount_type',
        'discount_rate_used',
        'vat_amount',
        'total_amount',
        'payment_method',
        'cash_tendered',
        'change_given',
        'gcash_reference_number',
      ].sort(),
    );
  });

  it('applies the dedicated receiptLookupLimiter (20 req/10min per IP) on top of the generic apiLimiter', async () => {
    vi.mocked(receiptsService.getPublicReceipt).mockResolvedValue(samplePublicReceipt);

    const ip = randomUUID();
    const handlers = getRouteHandlers(receiptsRouter, 'get', '/:transactionNumber');
    // Route must be [limiter, handler] — the limiter runs before the DB lookup.
    expect(handlers.length).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < 20; i++) {
      const req = mockReq({ ip, params: { transactionNumber: `MNL001-20260714-${String(i).padStart(6, '0')}` } });
      const res = mockRes();
      await runHandlers(handlers, req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    }

    // The 21st request from the same IP within the window is rejected before ever reaching the service/DB.
    const blockedReq = mockReq({ ip, params: { transactionNumber: 'MNL001-20260714-000021' } });
    const blockedRes = mockRes();
    vi.mocked(receiptsService.getPublicReceipt).mockClear();
    await runHandlers(handlers, blockedReq, blockedRes);

    expect(blockedRes.status).toHaveBeenCalledWith(429);
    const body = (blockedRes as unknown as { jsonBody: { error: { code: string } } }).jsonBody;
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(receiptsService.getPublicReceipt).not.toHaveBeenCalled();
  });

  it('demonstrates that sequential neighboring receipt numbers are otherwise reachable without auth (enumeration is possible in principle; mitigated by receiptLookupLimiter above, not by the lookup itself)', async () => {
    const neighbors = ['MNL001-20260714-000001', 'MNL001-20260714-000002', 'MNL001-20260714-000003'];
    for (const receiptNumber of neighbors) {
      vi.mocked(receiptsService.getPublicReceipt).mockResolvedValueOnce({ ...samplePublicReceipt, receipt_number: receiptNumber });
      const req = mockReq({ ip: randomUUID(), params: { transactionNumber: receiptNumber } });
      const res = mockRes();
      await runHandlers(getRouteHandlers(receiptsRouter, 'get', '/:transactionNumber'), req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(receiptsService.getPublicReceipt).toHaveBeenCalledWith(receiptNumber);
    }
  });
});
