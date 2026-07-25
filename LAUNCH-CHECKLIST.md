# POTATO CORNER LAUNCH CHECKLIST

## Pre-launch (mandatory before handoff)

This system was developed against the target Supabase project
`nliuhztaezaujzgtsrwp` as a single working environment (dev-mode
usage of the production project — see CR-005 decisions).

**The database currently contains development fixture data**:
- Test user accounts (super_admin@potato-corner.dev, etc.)
- Fixture branches (Puregold San Pablo, SM San Pablo, Downtown San Pablo)
- Fixture inventory levels (arbitrary 1000-unit stock)
- Fixture recipes (matching Potato Corner spreadsheet)
- Development audit log entries
- Development InventoryMovement entries
- Development ProductChangeLog entries

**Before handing this system to the owner:**

1. Take a snapshot of the current state (optional — for reference only).
2. Run `prisma migrate reset --force` against `nliuhztaezaujzgtsrwp` to
   wipe all fixture data.
3. Reapply migrations with `prisma migrate deploy`.
4. Seed ONLY real launch data via the admin UI or a launch-specific
   seed script:
   - Real staff user accounts (owner-provided credentials)
   - Real branch(es) — actual store locations
   - Zero starting inventory (owner will receive stock manually)
   - Real product catalog via the Product Builder UI (proposed by
     supervisor, approved by super_admin per CR-005 governance)
5. Alternatively: provision a fresh Supabase project for launch and
   retire `nliuhztaezaujzgtsrwp`.
6. Verify no audit log entries reference development actors.
7. Verify no InventoryMovement entries reference development sales.
8. Update `.env` and Vercel environment variables to point at the
   final launch database.

**This checklist must be completed before the owner receives access.**
