-- Branch Employee Authorization
-- Employees (`staff` rows) no longer carry their own login credentials —
-- they are authorized inside an already-authenticated `branch` session.
-- email/password_hash become optional; branch/supervisor/super_admin rows
-- are unaffected (application layer still requires both for those roles).
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

-- New Employee fields (Create Employee: Position, Notes).
ALTER TABLE "users" ADD COLUMN "position" TEXT;
ALTER TABLE "users" ADD COLUMN "notes" TEXT;
