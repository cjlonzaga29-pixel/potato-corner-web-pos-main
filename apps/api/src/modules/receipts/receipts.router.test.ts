import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';

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
  return { headers: {}, params: {}, query: {}, body: {}, originalUrl: '/api/receipts/test', ...overrides } as unknown as Request;
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

describe('GET /api/receipts/:transactionNumber', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires no authentication and returns the public receipt', async () => {
    vi.mocked(receiptsService.getPublicReceipt).mockResolvedValue({
      receipt_number: 'MNL001-20260714-000001',
      branch_name: 'Manila - Robinsons',
      status: 'completed',
      created_at: '2026-07-14T10:00:00.000Z',
      items: [],
      subtotal: 130,
      discount_amount: 0,
      discount_type: null,
      vat_amount: 13.93,
      total_amount: 130,
      payment_method: 'cash',
      cash_tendered: 150,
      change_given: 20,
      gcash_reference_number: null,
    });

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
});
