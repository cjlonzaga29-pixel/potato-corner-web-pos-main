import type { JwtPayload, Role } from '@potato-corner/shared';

/**
 * The canonical JWT payload type is @potato-corner/shared's `JwtPayload`
 * (a discriminated union on `role`) — it is re-exported here rather than
 * redefined, so there is exactly one source of truth for the locked JWT
 * structure. Deliberately does NOT include a `jti` field: the locked
 * structure is `{ user_id, role, email, branch_ids?, iat, exp }` with no
 * other fields. Token revocation (blacklisting) is implemented by hashing
 * the raw token string itself as the Redis key (see middleware/authenticate.ts
 * `blacklistKey`), which achieves the same "check token ID against
 * blacklist" requirement without adding an unapproved payload field.
 */
export type { JwtPayload };

export interface AuthenticatedUserSummary {
  id: string;
  role: Role;
  email: string;
  first_name: string;
  last_name: string;
  branch_ids: string[];
  must_change_password: boolean;
}

export interface LoginResponse {
  access_token: string;
  user: AuthenticatedUserSummary;
}

export interface RefreshResponse {
  access_token: string;
}

export interface TokenBlacklistEntry {
  tokenHash: string;
  expiresAt: Date;
}

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 401,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
