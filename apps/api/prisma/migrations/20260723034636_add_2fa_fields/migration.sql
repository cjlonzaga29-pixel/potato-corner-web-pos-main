-- Step 11b Phase 1: 2FA (TOTP) enrollment fields on users.
-- totp_secret is application-layer AES-256-GCM ciphertext (src/lib/encryption.ts).
-- totp_backup_codes stores bcrypt hashes, never plaintext.
ALTER TABLE "users" ADD COLUMN     "totp_secret" TEXT,
ADD COLUMN     "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totp_enrolled_at" TIMESTAMP(3),
ADD COLUMN     "totp_backup_codes" TEXT[] DEFAULT ARRAY[]::TEXT[];
