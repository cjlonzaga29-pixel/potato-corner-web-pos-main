import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { ROLES } from '@potato-corner/shared';

vi.mock('../modules/employees/employees.repository.js', () => ({
  employeesRepository: {
    findStatusById: vi.fn(),
  },
}));

const { employeesRepository } = await import('../modules/employees/employees.repository.js');
const { requireActiveEmployee, requireActiveSupervisor } = await import('./require-active-employee.js');

function mockRes() {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as Response;
  (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe('requireActiveSupervisor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op for a non-supervisor role — never queries the database', async () => {
    const req = { user: { user_id: 'staff-1', role: ROLES.STAFF } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireActiveSupervisor(req, res, next);

    expect(employeesRepository.findStatusById).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects with 403 SUPERVISOR_INACTIVE when the account is deactivated', async () => {
    (employeesRepository.findStatusById as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'inactive', isActive: false });
    const req = { user: { user_id: 'sup-1', role: ROLES.SUPERVISOR } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireActiveSupervisor(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'SUPERVISOR_INACTIVE' }) }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next for an active supervisor', async () => {
    (employeesRepository.findStatusById as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'active', isActive: true });
    const req = { user: { user_id: 'sup-2', role: ROLES.SUPERVISOR } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireActiveSupervisor(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('caches a confirmed-active result so a second request within the TTL skips the database', async () => {
    (employeesRepository.findStatusById as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'active', isActive: true });
    const req = { user: { user_id: 'sup-cache-1', role: ROLES.SUPERVISOR } } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;

    await requireActiveSupervisor(req, mockRes(), next);
    await requireActiveSupervisor(req, mockRes(), next);

    expect(employeesRepository.findStatusById).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledTimes(2);
  });

  /**
   * POS-PERF-P35R4 — documents the cache's known tradeoff explicitly: the
   * 10s positive-cache TTL means a deactivation that happens strictly
   * between two requests from the same supervisor is NOT guaranteed to be
   * observed on the very next request — only on the first request AFTER
   * the cache entry naturally expires. This mirrors requireActiveEmployee's
   * identical pre-existing cache (same TTL, same positive-only caching
   * rule) and is an accepted bound on the close of the window, not a full
   * close — the real-time floor is deactivation revoking refresh tokens
   * (blocks renewal) plus the access token's own short TTL (minutes, not
   * hours) expiring regardless of this cache.
   */
  it('a cached active result survives deactivation until the cache entry naturally expires, then a fresh check rejects it', async () => {
    vi.useFakeTimers();
    try {
      (employeesRepository.findStatusById as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'active', isActive: true });
      const req = { user: { user_id: 'sup-ttl-1', role: ROLES.SUPERVISOR } } as unknown as Request;
      const next = vi.fn() as unknown as NextFunction;

      await requireActiveSupervisor(req, mockRes(), next);
      expect(employeesRepository.findStatusById).toHaveBeenCalledOnce();

      // Deactivated now, but the cache entry (10s TTL) hasn't expired yet.
      (employeesRepository.findStatusById as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'inactive', isActive: false });
      vi.advanceTimersByTime(9_000);
      const resWithinTtl = mockRes();
      await requireActiveSupervisor(req, resWithinTtl, next);
      expect(employeesRepository.findStatusById).toHaveBeenCalledOnce();
      expect(resWithinTtl.status).not.toHaveBeenCalled();

      // Past the 10s TTL — the next request re-checks the database and
      // correctly rejects the now-deactivated account.
      vi.advanceTimersByTime(1_001);
      const resAfterTtl = mockRes();
      await requireActiveSupervisor(req, resAfterTtl, next);
      expect(employeesRepository.findStatusById).toHaveBeenCalledTimes(2);
      expect(resAfterTtl.status).toHaveBeenCalledWith(403);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('requireActiveEmployee (regression — unaffected by the requireActiveSupervisor addition)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is still a no-op for a supervisor role', async () => {
    const req = { user: { user_id: 'sup-3', role: ROLES.SUPERVISOR } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireActiveEmployee(req, res, next);

    expect(employeesRepository.findStatusById).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('still rejects an inactive staff session', async () => {
    (employeesRepository.findStatusById as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'inactive', isActive: false });
    const req = { user: { user_id: 'staff-inactive-1', role: ROLES.STAFF } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireActiveEmployee(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'EMPLOYEE_INACTIVE' }) }));
    expect(next).not.toHaveBeenCalled();
  });
});
