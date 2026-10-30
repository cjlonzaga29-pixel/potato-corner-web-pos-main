import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockApiClient } = vi.hoisted(() => ({ mockApiClient: vi.fn() }));
vi.mock('./api-client', () => ({ apiClient: mockApiClient }));

const { startBreakConfirmed, endBreakConfirmed, readAttendanceState } = await import('./attendance-breaks');

const EMPLOYEE = 'employee-1';
const BRANCH = 'branch-1';

function stateResponse(state: 'working' | 'on_break' | null, clockedOut = false) {
  return {
    data: {
      records: [{ clock_out_server_time: clockedOut ? '2026-01-01T10:00:00.000Z' : null, ...(state ? { attendance_state: state } : {}) }],
      total: 1,
      page: 1,
      limit: 1,
    },
    error: null,
    meta: null,
  };
}

function routeApi(post: unknown, read: unknown) {
  mockApiClient.mockImplementation(async (...args: unknown[]) => (String(args[0]).startsWith('/api/attendance/break/') ? post : read));
}

beforeEach(() => mockApiClient.mockReset());

describe('POS-PERF-P51 attendance-breaks — server confirmation only', () => {
  it('a clean success is confirmed without any extra read', async () => {
    mockApiClient.mockResolvedValueOnce({ data: { id: 'r' }, error: null, meta: null });
    await expect(startBreakConfirmed(EMPLOYEE, BRANCH, 'tok')).resolves.toEqual({ status: 'confirmed', record: { id: 'r' } });
    expect(mockApiClient).toHaveBeenCalledTimes(1);
    expect(mockApiClient).toHaveBeenCalledWith('/api/attendance/break/start', { method: 'POST', body: JSON.stringify({ branch_id: BRANCH }) }, 'tok', undefined);
  });

  it('lost response: reads the current state and confirms if the break did start — never sends a second Start Break', async () => {
    routeApi({ data: null, error: { code: 'NETWORK_ERROR', message: 'x' }, meta: null }, stateResponse('on_break'));
    await expect(startBreakConfirmed(EMPLOYEE, BRANCH, 'tok')).resolves.toMatchObject({ status: 'confirmed' });
    const posts = mockApiClient.mock.calls.filter(([path]) => String(path).startsWith('/api/attendance/break/'));
    expect(posts).toHaveLength(1);
  });

  it('lost response and the break did NOT start: reports failure — never claims success', async () => {
    routeApi({ data: null, error: { code: 'NETWORK_ERROR', message: 'x' }, meta: null }, stateResponse('working'));
    const result = await startBreakConfirmed(EMPLOYEE, BRANCH, 'tok');
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.message).toMatch(/has NOT started/);
  });

  it('offline (state cannot be read either): failure, with an explicit "not started" message', async () => {
    routeApi({ data: null, error: { code: 'NETWORK_ERROR', message: 'x' }, meta: null }, { data: null, error: { code: 'NETWORK_ERROR' }, meta: null });
    const result = await startBreakConfirmed(EMPLOYEE, BRANCH, 'tok');
    expect(result).toMatchObject({ status: 'failed', code: 'NETWORK_ERROR' });
  });

  it('ALREADY_ON_BREAK (an earlier attempt committed) counts as confirmed', async () => {
    routeApi({ data: null, error: { code: 'ALREADY_ON_BREAK', message: 'x' }, meta: null }, stateResponse('on_break'));
    await expect(startBreakConfirmed(EMPLOYEE, BRANCH, 'tok')).resolves.toMatchObject({ status: 'confirmed' });
  });

  it('Resume: NOT_ON_BREAK after a lost first response is confirmed by the state read', async () => {
    routeApi({ data: null, error: { code: 'NOT_ON_BREAK', message: 'x' }, meta: null }, stateResponse('working'));
    await expect(endBreakConfirmed(EMPLOYEE, BRANCH, 'tok')).resolves.toMatchObject({ status: 'confirmed' });
  });

  it('Resume refused while the server still says on_break: failure with the server message', async () => {
    routeApi({ data: null, error: { code: 'EMPLOYEE_INACTIVE', message: 'This employee session is no longer active' }, meta: null }, stateResponse('on_break'));
    await expect(endBreakConfirmed(EMPLOYEE, BRANCH, 'tok')).resolves.toEqual({
      status: 'failed',
      code: 'EMPLOYEE_INACTIVE',
      message: 'This employee session is no longer active',
    });
  });

  it('a pre-P51 API (no break route, no attendance_state) is a failure, never a guess', async () => {
    routeApi({ data: null, error: { code: 'NOT_FOUND', message: 'Not found' }, meta: null }, stateResponse(null));
    await expect(startBreakConfirmed(EMPLOYEE, BRANCH, 'tok')).resolves.toMatchObject({ status: 'failed' });
  });

  it('readAttendanceState: clocked-out and pre-P51 records are told apart', async () => {
    mockApiClient.mockResolvedValueOnce(stateResponse(null, true));
    await expect(readAttendanceState(EMPLOYEE)).resolves.toBe('clocked_out');
    mockApiClient.mockResolvedValueOnce(stateResponse(null));
    await expect(readAttendanceState(EMPLOYEE)).resolves.toBeNull();
  });
});
