import type { JwtPayload } from '@potato-corner/shared';
import type { Shift } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      /** Populated by the authenticate middleware after JWT verification. */
      user?: JwtPayload;
      /** Populated by the shift-guard middleware on POS transaction endpoints. */
      activeShift?: Shift;
    }
  }
}

export {};
