import { randomInt } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { config } from '../../config/index.js';
import { sha256Hex } from '../../lib/hash.js';

const BCRYPT_COST_FACTOR = 12;
const BACKUP_CODE_LENGTH = 10;
const BACKUP_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // excludes ambiguous 0/O, 1/I/L

const ISSUER = 'Potato Corner';

function generateBackupCode(): string {
  let code = '';
  for (let i = 0; i < BACKUP_CODE_LENGTH; i++) {
    code += BACKUP_CODE_CHARSET[randomInt(BACKUP_CODE_CHARSET.length)];
  }
  return code;
}

// -- Step 11b Phase 2: login challenge token ---------------------------------
// Deliberately separate from the locked access-token JWT (auth.types.ts) —
// signed HS256 with config.jwt.refreshSecret (an existing secret already
// scoped to short-lived, non-access-token auth artifacts) rather than the
// RS256 access-token keypair, so this never touches the locked payload shape.
const CHALLENGE_TOKEN_TTL_SECONDS = 5 * 60;
const CHALLENGE_PURPOSE = '2fa_challenge';

interface ChallengeJwtPayload {
  user_id: string;
  device_id: string;
  purpose: typeof CHALLENGE_PURPOSE;
}

/**
 * Single-use enforcement for challenge tokens: an in-memory Set of hashed
 * tokens already consumed. Marked used only on a *successful* verify — an
 * invalid code/backup code deliberately leaves the token valid so a typo
 * doesn't force the user back through a full re-login within the 5-minute
 * window. Mirrors the refresh-token-rotation cache pattern but in-memory,
 * since challenge tokens live at most 5 minutes and don't need to survive a
 * process restart. Pruned lazily on each check/mark call rather than via a
 * background timer.
 */
const usedChallengeTokenHashes = new Map<string, number>(); // hash -> expiresAtMs

function pruneUsedChallengeTokens(): void {
  const now = Date.now();
  for (const [hash, expiresAtMs] of usedChallengeTokenHashes) {
    if (expiresAtMs <= now) usedChallengeTokenHashes.delete(hash);
  }
}

export const totpService = {
  generateSecret(): string {
    return authenticator.generateSecret();
  },

  async generateQrCodeDataUrl(email: string, secret: string): Promise<string> {
    const otpauthUri = authenticator.keyuri(email, ISSUER, secret);
    return QRCode.toDataURL(otpauthUri);
  },

  verifyToken(token: string, secret: string): boolean {
    try {
      return authenticator.verify({ token, secret });
    } catch {
      return false;
    }
  },

  generateBackupCodes(count = 10): string[] {
    const codes = new Set<string>();
    while (codes.size < count) {
      codes.add(generateBackupCode());
    }
    return Array.from(codes);
  },

  hashBackupCode(code: string): Promise<string> {
    return bcrypt.hash(code, BCRYPT_COST_FACTOR);
  },

  async verifyBackupCode(code: string, hashedCodes: string[]): Promise<{ matched: boolean; remainingCodes: string[] }> {
    for (const hashed of hashedCodes) {
      if (await bcrypt.compare(code, hashed)) {
        return { matched: true, remainingCodes: hashedCodes.filter((entry) => entry !== hashed) };
      }
    }
    return { matched: false, remainingCodes: hashedCodes };
  },

  issueChallengeToken(userId: string, deviceId: string): string {
    const payload: ChallengeJwtPayload = { user_id: userId, device_id: deviceId, purpose: CHALLENGE_PURPOSE };
    return jwt.sign(payload, config.jwt.refreshSecret, { expiresIn: CHALLENGE_TOKEN_TTL_SECONDS });
  },

  /** Returns null for an invalid, expired, wrong-purpose, or already-used (via markChallengeUsed) token. */
  verifyChallengeToken(token: string): { userId: string; deviceId: string } | null {
    pruneUsedChallengeTokens();
    if (usedChallengeTokenHashes.has(sha256Hex(token))) return null;

    try {
      const decoded = jwt.verify(token, config.jwt.refreshSecret) as ChallengeJwtPayload;
      if (decoded.purpose !== CHALLENGE_PURPOSE) return null;
      return { userId: decoded.user_id, deviceId: decoded.device_id };
    } catch {
      return null;
    }
  },

  markChallengeUsed(token: string): void {
    pruneUsedChallengeTokens();
    const decoded = jwt.decode(token) as (ChallengeJwtPayload & { exp?: number }) | null;
    const expiresAtMs = decoded?.exp ? decoded.exp * 1000 : Date.now() + CHALLENGE_TOKEN_TTL_SECONDS * 1000;
    usedChallengeTokenHashes.set(sha256Hex(token), expiresAtMs);
  },

  CHALLENGE_TOKEN_TTL_SECONDS,
};
