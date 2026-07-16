import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/index.js', () => ({
  config: {
    encryptionKey: Buffer.from('a'.repeat(32)).toString('base64'),
    hashKey: Buffer.from('b'.repeat(32)).toString('base64'),
  },
}));

const { hashField, encryptField, decryptField } = await import('./encryption.js');

describe('hashField', () => {
  it('is deterministic for the same plaintext', () => {
    expect(hashField('PWD-12345')).toBe(hashField('PWD-12345'));
  });

  it('produces different output for different plaintext', () => {
    expect(hashField('PWD-12345')).not.toBe(hashField('PWD-99999'));
  });

  it('returns a 64-character lowercase hex string (SHA-256 digest)', () => {
    const result = hashField('PWD-12345');
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent from encryptField — encrypting twice differs, hashing twice does not', () => {
    const encryptedA = encryptField('PWD-12345');
    const encryptedB = encryptField('PWD-12345');
    expect(encryptedA).not.toBe(encryptedB);
    expect(decryptField(encryptedA)).toBe('PWD-12345');
    expect(hashField('PWD-12345')).toBe(hashField('PWD-12345'));
  });
});
