import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';

vi.mock('../../lib/catalog-change-notifier.js', () => ({ queueCatalogChanged: vi.fn() }));
vi.mock('./products.repository.js', () => ({ productsRepository: { findAvailabilityBranchIds: vi.fn() } }));

const { queueCatalogChanged } = await import('../../lib/catalog-change-notifier.js');
const { notifyCatalogChangeOnSuccess } = await import('./products.catalog-events.js');

function fakeRes(statusCode: number) {
  const res = new EventEmitter() as EventEmitter & { statusCode: number; json: (body: unknown) => unknown };
  res.statusCode = statusCode;
  res.json = vi.fn((body: unknown) => body);
  return res;
}

async function run(method: string, path: string, statusCode: number, lookup: (id: string) => Promise<string[]>, body?: unknown) {
  const res = fakeRes(statusCode);
  const next = vi.fn();
  await notifyCatalogChangeOnSuccess(lookup)({ method, path } as Request, res as unknown as Response, next);
  if (body !== undefined) res.json(body);
  res.emit('finish');
  await new Promise((resolve) => setImmediate(resolve));
  return { next };
}

beforeEach(() => vi.clearAllMocks());

describe('notifyCatalogChangeOnSuccess (POS-PERF-P69R)', () => {
  const productId = randomUUID();
  const branchA = randomUUID();
  const branchB = randomUUID();

  it('hints the product\'s branches after a successful write', async () => {
    const lookup = vi.fn().mockResolvedValue([branchA]);
    const { next } = await run('PATCH', `/${productId}/variants/${randomUUID()}`, 200, lookup);
    expect(next).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith(productId);
    expect(queueCatalogChanged).toHaveBeenCalledWith([branchA]);
  });

  it('sends nothing for reads, the read-only catalog checks, or a refused write', async () => {
    const lookup = vi.fn().mockResolvedValue([branchA]);
    await run('GET', `/${productId}`, 200, lookup);
    await run('POST', '/catalog/availability-check', 200, lookup);
    await run('PATCH', `/${productId}`, 403, lookup);
    await run('PATCH', `/${productId}`, 409, lookup);
    expect(queueCatalogChanged).not.toHaveBeenCalled();
  });

  it('a product DELETE also hints the branches that listed it before the delete', async () => {
    const lookup = vi.fn().mockResolvedValueOnce([branchA, branchB]).mockResolvedValueOnce([]);
    await run('DELETE', `/${productId}`, 200, lookup);
    expect(queueCatalogChanged).toHaveBeenCalledWith([branchA, branchB]);
  });

  it('a create reads the new product id from its own response', async () => {
    const created = randomUUID();
    const lookup = vi.fn().mockResolvedValue([branchB]);
    await run('POST', '/', 201, lookup, { data: { id: created }, error: null, meta: null });
    expect(lookup).toHaveBeenCalledWith(created);
    expect(queueCatalogChanged).toHaveBeenCalledWith([branchB]);
  });

  it('a failed lookup sends no hint and never fails the request', async () => {
    const lookup = vi.fn().mockRejectedValue(new Error('db down'));
    const { next } = await run('DELETE', `/${productId}`, 200, lookup);
    expect(next).toHaveBeenCalledOnce();
    expect(queueCatalogChanged).toHaveBeenCalledWith([]);
  });
});
