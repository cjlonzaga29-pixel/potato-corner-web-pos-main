import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * POS-PERF-P35R4 — same inactive-supervisor gap as
 * products.inactive-supervisor.integration.test.ts, exercised against the
 * universal-inventory catalog-definition surface (categories/units/
 * conversions/items), which has its own isCatalogManager checks
 * (universal-inventory.service.ts) and its own supervisorOnly router wiring
 * — a separate codepath from products, not covered by that other test.
 * Covers both an ownership-gated write (PATCH category, isCatalogManager
 * applies) and a no-ownership-yet write (POST category, brand new row) —
 * a deactivated supervisor must be blocked from both.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const isLocalDatabase = /(^|@)(127\.0\.0\.1|localhost)(:|\/)/.test(databaseUrl);

const { app } = await import('../../app.js');
const { prisma } = await import('../../lib/prisma.js');
const { generateSupervisorToken } = await import('../../test-utils/auth-tokens.js');

describe.skipIf(!isLocalDatabase)('universal-inventory catalog-definition writes after supervisor deactivation (real Express + Postgres)', () => {
  let server: Server;
  let baseUrl: string;
  let supervisorId: string;
  let token: string;
  let categoryId: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    const sup = await prisma.user.create({
      data: {
        role: 'supervisor',
        firstName: 'Sup',
        lastName: 'InvDeact',
        employmentType: 'regular',
        email: `supinvdeact-${randomUUID()}@test.local`,
        isActive: true,
      },
    });
    supervisorId = sup.id;
    token = generateSupervisorToken([], { userId: supervisorId });

    const category = await prisma.inventoryCategory.create({
      data: { name: `P35R4 Category ${randomUUID().slice(0, 8)}`, createdBy: supervisorId },
    });
    categoryId = category.id;

    await prisma.user.update({
      where: { id: supervisorId },
      data: { isActive: false, status: 'inactive', deactivatedAt: new Date(), deactivationReason: 'test' },
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.inventoryCategory.deleteMany({ where: { createdBy: supervisorId } });
    await prisma.user.deleteMany({ where: { id: supervisorId } });
  });

  it('rejects updating an existing (owned) category from a deactivated supervisor', async () => {
    const res = await fetch(`${baseUrl}/api/universal-inventory/categories/${categoryId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed by deactivated supervisor' }),
    });

    expect(res.status).toBe(403);
    const finalRow = await prisma.inventoryCategory.findUniqueOrThrow({ where: { id: categoryId } });
    expect(finalRow.name).not.toBe('Renamed by deactivated supervisor');
  });

  it('rejects creating a brand-new category from a deactivated supervisor', async () => {
    const res = await fetch(`${baseUrl}/api/universal-inventory/categories`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Should never be created ${randomUUID().slice(0, 8)}` }),
    });

    expect(res.status).toBe(403);
  });
});
