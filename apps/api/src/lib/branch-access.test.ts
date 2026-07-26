import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ROLES } from '@potato-corner/shared';

/**
 * Supervisor branch access is an intentional authorization-model change:
 * Supervisor is organization-wide over every currently-ACTIVE branch,
 * resolved fresh from the database on every call — never the JWT's
 * `branch_ids` claim, and with no UserBranchAssignment requirement. These
 * tests pin that contract directly against the lib, independent of any one
 * module's usage of it.
 */
vi.mock('../modules/branches/branches.repository.js', () => ({
  branchesRepository: {
    findAllActiveBranchIds: vi.fn(),
  },
}));

const { branchesRepository } = await import('../modules/branches/branches.repository.js');
const { getAccessibleBranchIds, hasBranchAccess, assertBranchAccess } = await import('./branch-access.js');

class TestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
  }
}

const IAT_EXP = { iat: 0, exp: 9999999999 };

function supervisor(branchIds: string[] = []) {
  return { user_id: randomUUID(), role: ROLES.SUPERVISOR, email: 'sup@test.com', branch_ids: branchIds, ...IAT_EXP };
}

function branchActor(branchId: string) {
  return { user_id: randomUUID(), role: ROLES.BRANCH, email: 'branch@test.com', branch_ids: [branchId], ...IAT_EXP };
}

function staffActor(branchId: string) {
  return { user_id: randomUUID(), role: ROLES.STAFF, email: null, branch_ids: [branchId], ...IAT_EXP };
}

function superAdmin() {
  return { user_id: randomUUID(), role: ROLES.SUPER_ADMIN, email: 'admin@test.com', ...IAT_EXP } as const;
}

beforeEach(() => {
  vi.mocked(branchesRepository.findAllActiveBranchIds).mockReset();
});

describe('getAccessibleBranchIds', () => {
  it("super_admin always resolves to 'all', without querying the database", async () => {
    const result = await getAccessibleBranchIds(superAdmin());
    expect(result).toBe('all');
    expect(branchesRepository.findAllActiveBranchIds).not.toHaveBeenCalled();
  });

  it('supervisor with zero UserBranchAssignment records (empty JWT branch_ids) receives every active branch', async () => {
    const branchA = randomUUID();
    const branchB = randomUUID();
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([branchA, branchB]);

    const result = await getAccessibleBranchIds(supervisor([]));

    expect(result).toEqual([branchA, branchB]);
  });

  it('supervisor with a stale JWT branch_ids claim still receives every active branch from the database', async () => {
    const staleBranch = randomUUID();
    const currentBranch = randomUUID();
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([currentBranch]);

    const result = await getAccessibleBranchIds(supervisor([staleBranch]));

    expect(result).toEqual([currentBranch]);
    expect(result).not.toContain(staleBranch);
  });

  it('a newly created/activated branch becomes visible to Supervisor immediately on the next call — no relogin needed', async () => {
    const existingBranch = randomUUID();
    const newBranch = randomUUID();
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValueOnce([existingBranch]);

    const before = await getAccessibleBranchIds(supervisor([]));
    expect(before).toEqual([existingBranch]);

    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValueOnce([existingBranch, newBranch]);
    const after = await getAccessibleBranchIds(supervisor([]));

    expect(after).toEqual([existingBranch, newBranch]);
  });

  it('branch role remains scoped to its own JWT branch_ids — unaffected by the database', async () => {
    const branchId = randomUUID();
    const result = await getAccessibleBranchIds(branchActor(branchId));

    expect(result).toEqual([branchId]);
    expect(branchesRepository.findAllActiveBranchIds).not.toHaveBeenCalled();
  });

  it('staff role remains scoped to its own JWT branch_ids — unaffected by the database', async () => {
    const branchId = randomUUID();
    const result = await getAccessibleBranchIds(staffActor(branchId));

    expect(result).toEqual([branchId]);
    expect(branchesRepository.findAllActiveBranchIds).not.toHaveBeenCalled();
  });
});

describe('hasBranchAccess / assertBranchAccess', () => {
  it('supervisor can access an active branch that is not present in their JWT branch_ids', async () => {
    const activeBranch = randomUUID();
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([activeBranch]);

    await expect(hasBranchAccess(supervisor([]), activeBranch)).resolves.toBe(true);
    await expect(assertBranchAccess(supervisor([]), activeBranch, TestError)).resolves.toBeUndefined();
  });

  it('supervisor cannot access an inactive branch', async () => {
    const inactiveBranch = randomUUID();
    // findAllActiveBranchIds only ever returns active branches — an inactive
    // one is simply absent from the list.
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([]);

    await expect(hasBranchAccess(supervisor([]), inactiveBranch)).resolves.toBe(false);
    await expect(assertBranchAccess(supervisor([]), inactiveBranch, TestError)).rejects.toMatchObject({
      code: 'BRANCH_ACCESS_DENIED',
      statusCode: 403,
    });
  });

  it('supervisor cannot access a closed branch', async () => {
    const otherActiveBranch = randomUUID();
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([otherActiveBranch]);

    const closedBranch = randomUUID();
    await expect(hasBranchAccess(supervisor([]), closedBranch)).resolves.toBe(false);
  });

  it('supervisor cannot access a deleted/unknown branch id', async () => {
    vi.mocked(branchesRepository.findAllActiveBranchIds).mockResolvedValue([randomUUID()]);

    await expect(hasBranchAccess(supervisor([]), randomUUID())).resolves.toBe(false);
  });

  it('super_admin can access any branch id without a database lookup', async () => {
    await expect(hasBranchAccess(superAdmin(), randomUUID())).resolves.toBe(true);
    expect(branchesRepository.findAllActiveBranchIds).not.toHaveBeenCalled();
  });

  it('branch role is denied a branch outside its own JWT branch_ids', async () => {
    const ownBranch = randomUUID();
    const otherBranch = randomUUID();

    await expect(hasBranchAccess(branchActor(ownBranch), otherBranch)).resolves.toBe(false);
    await expect(assertBranchAccess(branchActor(ownBranch), otherBranch, TestError)).rejects.toMatchObject({
      code: 'BRANCH_ACCESS_DENIED',
      statusCode: 403,
    });
  });

  it('staff role is denied a branch outside its own JWT branch_ids', async () => {
    const ownBranch = randomUUID();
    const otherBranch = randomUUID();

    await expect(hasBranchAccess(staffActor(ownBranch), otherBranch)).resolves.toBe(false);
  });
});
