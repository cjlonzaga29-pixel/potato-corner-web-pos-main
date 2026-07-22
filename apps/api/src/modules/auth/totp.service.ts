import { randomInt } from 'node:crypto';
import bcrypt from 'bcrypt';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';

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
};
