/**
 * POS-PERF-P52 — payroll module types. Request/response shapes live in
 * @potato-corner/shared (payroll.schema.ts); this file holds module-local
 * types only.
 */

export class PayrollError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PayrollError';
  }
}

/** The authenticated caller, as the service needs it (from the verified JWT, never the request body). */
export interface PayrollActor {
  id: string;
  role: string;
}
