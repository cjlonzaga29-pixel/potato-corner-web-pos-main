import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { config } from '../../config/index.js';
import { totpService } from './totp.service.js';

describe('totpService.generateSecret', () => {
  it('returns a valid base32 secret', () => {
    const secret = totpService.generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(16);
  });
});

describe('totpService.verifyToken', () => {
  it('accepts the current TOTP code for the secret', () => {
    const secret = totpService.generateSecret();
    const token = authenticator.generate(secret);
    expect(totpService.verifyToken(token, secret)).toBe(true);
  });

  it('rejects an invalid code', () => {
    const secret = totpService.generateSecret();
    expect(totpService.verifyToken('000000', secret)).toBe(false);
  });
});

describe('totpService.generateBackupCodes', () => {
  it('returns 10 unique codes', () => {
    const codes = totpService.generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });
});

describe('totpService.verifyBackupCode', () => {
  it('returns matched=true and removes the used code', async () => {
    const codes = totpService.generateBackupCodes();
    const hashed = await Promise.all(codes.map((code) => totpService.hashBackupCode(code)));

    const result = await totpService.verifyBackupCode(codes[0] as string, hashed);

    expect(result.matched).toBe(true);
    expect(result.remainingCodes).toHaveLength(hashed.length - 1);
  });
});

describe('totpService.verifyChallengeToken', () => {
  it('accepts a token signed with the intended algorithm (HS256)', () => {
    const token = totpService.issueChallengeToken('user-1', 'device-1');
    const result = totpService.verifyChallengeToken(token);
    expect(result).toEqual({ userId: 'user-1', deviceId: 'device-1' });
  });

  it('rejects a token signed with a different algorithm', () => {
    const forged = jwt.sign(
      { user_id: 'user-1', device_id: 'device-1', purpose: '2fa_challenge' },
      config.jwt.refreshSecret,
      { expiresIn: totpService.CHALLENGE_TOKEN_TTL_SECONDS, algorithm: 'HS384' },
    );
    expect(totpService.verifyChallengeToken(forged)).toBeNull();
  });

  it('rejects an expired challenge token', () => {
    const expired = jwt.sign(
      { user_id: 'user-1', device_id: 'device-1', purpose: '2fa_challenge' },
      config.jwt.refreshSecret,
      { expiresIn: -10, algorithm: 'HS256' },
    );
    expect(totpService.verifyChallengeToken(expired)).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(totpService.verifyChallengeToken('not-a-jwt')).toBeNull();
  });
});
