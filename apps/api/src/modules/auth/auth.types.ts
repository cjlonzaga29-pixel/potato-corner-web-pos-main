import type { JwtPayload, Role } from '@potato-corner/shared';

/**
 * The canonical JWT payload type is @potato-corner/shared's `JwtPayload`
 * (a discriminated union on `role`) — it is re-exported here rather than
 * redefined, so there is exactly one source of truth for the locked JWT
 * structure. Deliberately does NOT include a `jti` field: the locked
 * structure is `{ user_id, role, email, branch_ids?, iat, exp }` with no
 * other fields. Token revocation (blacklisting) is implemented by hashing
 * the raw token string itself as the RevokedToken table's lookup key (see
 * middleware/authenticate.ts `revokedTokenHash`), which achieves the same
 * "check token ID against blacklist" requirement without adding an
 * unapproved payload field.
 */
export type { JwtPayload };

export interface AuthenticatedUserSummary {
  id: string;
  role: Role;
  /** Nullable — `staff` (Employees) have no email (Branch Employee Authorization). */
  email: string | null;
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

/** Step 11b Phase 2: returned from login() in place of a session when the user has 2FA enabled. */
export interface ChallengeResponse {
  challenge_required: true;
  challenge_token: string;
  expires_in: number;
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
