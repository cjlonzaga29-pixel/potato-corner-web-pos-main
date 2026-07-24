import { z } from 'zod';
import { ROLES, type Role } from '../constants/roles.js';

const roleValues = Object.values(ROLES) as [Role, ...Role[]];

/**
 * Password complexity: minimum 8 characters, at least one uppercase, one
 * lowercase, one digit, and one special character. Applied to every
 * new-password field (change, reset, employee creation/reset) — not to the
 * login password, which only needs to match whatever hash is already
 * stored. Exported so other modules (e.g. employee.schema.ts) reuse the
 * exact same rule instead of redefining it.
 */
export const strongPasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

/**
 * Auth wire-format fields are snake_case (email, device_id, access_token, …),
 * matching the JWT payload's own snake_case convention (user_id, branch_ids)
 * rather than the rest of the app's camelCase REST convention — this keeps
 * the auth module's request/response/token shapes internally consistent.
 */
export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
  device_id: z.uuid(),
});

/** The refresh token itself travels only via HttpOnly cookie, never in a request body. */
export const refreshSchema = z.object({
  device_id: z.uuid(),
});

export const changePasswordSchema = z
  .object({
    current_password: z.string().min(8),
    new_password: strongPasswordSchema,
    confirm_password: z.string(),
  })
  .refine((data) => data.new_password === data.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  });

export const resetRequestSchema = z.object({
  email: z.email(),
});

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1),
    new_password: strongPasswordSchema,
    confirm_password: z.string(),
  })
  .refine((data) => data.new_password === data.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  });

export const pinSetSchema = z.object({
  pin: z.string().regex(/^\d{6}$/, 'PIN must be exactly 6 digits'),
});

export const pinLoginSchema = z.object({
  user_id: z.uuid(),
  pin: z.string().regex(/^\d{6}$/, 'PIN must be exactly 6 digits'),
  device_id: z.uuid(),
});

/** Super Admin manual unlock — clears the lockout counters set by repeated failed logins. */
export const unlockAccountSchema = z.object({
  user_id: z.uuid(),
});

/**
 * JWT payload shape. branch_ids is required for supervisor/staff, absent
 * for super_admin. must_change_password is a Phase 5 addition to the
 * locked structure — added under Phase 5's explicit instruction (the
 * must-change-password gate needs it available on every authenticated
 * request without a DB round trip); no other field was added or renamed.
 * Optional (not required) so pre-Phase-5 test fixtures / hand-built
 * payloads that predate this field still validate — every token this
 * codebase actually issues (auth.service.ts's buildJwtPayload) sets it
 * explicitly to a real boolean regardless.
 */
export const jwtPayloadSchema = z.discriminatedUnion('role', [
  z.object({
    user_id: z.uuid(),
    role: z.literal(ROLES.SUPER_ADMIN),
    email: z.email(),
    must_change_password: z.boolean().optional(),
    iat: z.number(),
    exp: z.number(),
  }),
  z.object({
    user_id: z.uuid(),
    role: z.literal(ROLES.SUPERVISOR),
    email: z.email(),
    branch_ids: z.array(z.uuid()).min(1),
    must_change_password: z.boolean().optional(),
    iat: z.number(),
    exp: z.number(),
  }),
  z.object({
    user_id: z.uuid(),
    role: z.literal(ROLES.BRANCH),
    email: z.email(),
    branch_ids: z.array(z.uuid()).length(1),
    must_change_password: z.boolean().optional(),
    iat: z.number(),
    exp: z.number(),
  }),
  z.object({
    user_id: z.uuid(),
    role: z.literal(ROLES.STAFF),
    email: z.email(),
    branch_ids: z.array(z.uuid()).length(1),
    must_change_password: z.boolean().optional(),
    iat: z.number(),
    exp: z.number(),
  }),
]);

export const roleSchema = z.enum(roleValues);

/**
 * Accepts either a 6-digit TOTP code or a 10-char alphanumeric backup code
 * (see totp.service.ts's BACKUP_CODE_LENGTH) — disable2FA accepts both,
 * confirm/regenerate only ever receive a TOTP code but reuse the same
 * permissive shape rather than defining a second near-identical schema.
 */
export const totpTokenSchema = z.string().min(6).max(10);

export const confirm2FASchema = z.object({
  token: totpTokenSchema,
});

export const disable2FASchema = z.object({
  current_password: z.string().min(8),
  token: totpTokenSchema,
});

export const regenerateBackupCodesSchema = z.object({
  token: totpTokenSchema,
});

/**
 * Step 11b Phase 2: login challenge verification. challenge_token is an
 * opaque signed JWT string (see totp.service.ts's issueChallengeToken), not
 * validated further here — the service verifies its signature/expiry/purpose.
 */
export const verify2FALoginSchema = z.object({
  challenge_token: z.string().min(1),
  totp_code: z.string().regex(/^\d{6}$/, 'Code must be exactly 6 digits'),
  device_id: z.uuid(),
});

export const verify2FABackupCodeSchema = z.object({
  challenge_token: z.string().min(1),
  backup_code: z.string().regex(/^[A-Za-z0-9]{10}$/, 'Backup code must be exactly 10 characters'),
  device_id: z.uuid(),
});
