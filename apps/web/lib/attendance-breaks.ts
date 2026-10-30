import type { AttendanceListResponse, AttendanceResponse, AttendanceState } from '@potato-corner/shared';
import { apiClient } from './api-client';

/**
 * POS-PERF-P51 — Start Break / Resume Work with server confirmation only.
 *
 * Neither action is ever queued offline or given a client timestamp: the
 * server stamps both ends of the interval. When a request does not come back
 * with a clear answer (no connection, lost response, server error), the
 * outcome is decided by reading the employee's CURRENT attendance state from
 * the server — never by retrying blindly — so a lost response can never
 * create a second break, and a failed request is never shown as success.
 *
 * Every repeat is also safe server-side: a second Start Break gets 409
 * ALREADY_ON_BREAK and a second Resume gets 409 NOT_ON_BREAK, neither of
 * which writes anything.
 */

export type BreakActionResult =
  | { status: 'confirmed'; record: AttendanceResponse | null }
  | { status: 'failed'; code: string | null; message: string };

interface ApiErrorShape {
  error: { code: string; message?: string } | string | null;
}

function errorOf(response: ApiErrorShape): { code: string | null; message: string | null } {
  if (!response.error) return { code: null, message: null };
  if (typeof response.error === 'string') return { code: null, message: response.error };
  return { code: response.error.code, message: response.error.message ?? null };
}

/**
 * The employee's attendance state as the server sees it right now, or null
 * when it can't be read (offline, or a pre-P51 API that doesn't report it).
 * Read with the Branch Account's own session unless a token is given — the
 * branch session may read any employee assigned to its branch.
 */
export async function readAttendanceState(employeeId: string, accessToken?: string): Promise<AttendanceState | null> {
  const response = await apiClient<AttendanceListResponse>(`/api/attendance/employee/${employeeId}?page=1&limit=1`, undefined, accessToken);
  if (!response.data) return null;
  const latest = response.data.records[0];
  if (!latest) return 'clocked_out';
  if (latest.clock_out_server_time !== null) return 'clocked_out';
  return latest.attendance_state ?? null;
}

async function confirmBreakAction(
  action: 'start' | 'end',
  employeeId: string,
  branchId: string,
  accessToken: string,
  refreshAccessToken?: () => Promise<string | null>,
): Promise<BreakActionResult> {
  const expected: AttendanceState = action === 'start' ? 'on_break' : 'working';
  const alreadyCode = action === 'start' ? 'ALREADY_ON_BREAK' : 'NOT_ON_BREAK';
  const response = await apiClient<AttendanceResponse>(
    `/api/attendance/break/${action}`,
    { method: 'POST', body: JSON.stringify({ branch_id: branchId }) },
    accessToken,
    refreshAccessToken,
  );
  if (response.data) return { status: 'confirmed', record: response.data };

  const { code, message } = errorOf(response);
  // Anything other than a clean success — including "already on break" /
  // "not on break", a dropped connection or a server error — is settled by
  // what the server says the state is now.
  const state = await readAttendanceState(employeeId);
  if (state === expected) return { status: 'confirmed', record: null };

  if (code === alreadyCode && state === null) {
    // The server itself said the state already matches; only the follow-up
    // read failed. Its own answer is enough.
    return { status: 'confirmed', record: null };
  }
  if (state === 'clocked_out') {
    return { status: 'failed', code: 'NOT_CLOCKED_IN', message: 'This employee is clocked out.' };
  }
  if (code === 'NETWORK_ERROR' || code === 'UNREADABLE_RESPONSE') {
    return {
      status: 'failed',
      code: code ?? 'CONNECTION_UNCERTAIN',
      message:
        action === 'start'
          ? 'Could not confirm the break with the server. The break has NOT started — check your connection and try again.'
          : 'Could not confirm Resume Work with the server. You are still on break — check your connection and try again.',
    };
  }
  return {
    status: 'failed',
    code,
    message:
      message ??
      (action === 'start' ? 'The server did not confirm the break, so it has NOT started.' : 'The server did not confirm Resume Work — you are still on break.'),
  };
}

export function startBreakConfirmed(
  employeeId: string,
  branchId: string,
  accessToken: string,
  refreshAccessToken?: () => Promise<string | null>,
): Promise<BreakActionResult> {
  return confirmBreakAction('start', employeeId, branchId, accessToken, refreshAccessToken);
}

export function endBreakConfirmed(employeeId: string, branchId: string, accessToken: string): Promise<BreakActionResult> {
  return confirmBreakAction('end', employeeId, branchId, accessToken);
}

/** "On break since 2:05 PM" — local display only; the timestamp itself is the server's. */
export function formatBreakSince(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
