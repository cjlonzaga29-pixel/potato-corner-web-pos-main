import { describe, expect, it } from 'vitest';
import {
  computeShadowBomDeductionEnabledForBranch,
  parseShadowBomDeductionBranchIds,
  shadowBomDeductionBranchIdsSchema,
} from './index.js';

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const BRANCH_B = '22222222-2222-4222-8222-222222222222';

describe('parseShadowBomDeductionBranchIds', () => {
  it('returns an empty array for an empty string', () => {
    expect(parseShadowBomDeductionBranchIds('')).toEqual([]);
  });

  it('trims whitespace around each id', () => {
    expect(parseShadowBomDeductionBranchIds(`  ${BRANCH_A} , ${BRANCH_B}  `)).toEqual([BRANCH_A, BRANCH_B]);
  });

  it('removes duplicate ids', () => {
    expect(parseShadowBomDeductionBranchIds(`${BRANCH_A},${BRANCH_A},${BRANCH_B}`)).toEqual([BRANCH_A, BRANCH_B]);
  });

  it('drops empty segments produced by trailing/consecutive commas', () => {
    expect(parseShadowBomDeductionBranchIds(`${BRANCH_A},,`)).toEqual([BRANCH_A]);
  });
});

describe('shadowBomDeductionBranchIdsSchema', () => {
  it('accepts an empty/unset value as an empty list', () => {
    const result = shadowBomDeductionBranchIdsSchema.safeParse('');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([]);
  });

  it('accepts a comma-separated list of valid UUIDs', () => {
    const result = shadowBomDeductionBranchIdsSchema.safeParse(`${BRANCH_A},${BRANCH_B}`);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([BRANCH_A, BRANCH_B]);
  });

  it('rejects a malformed UUID', () => {
    const result = shadowBomDeductionBranchIdsSchema.safeParse(`${BRANCH_A},not-a-uuid`);
    expect(result.success).toBe(false);
  });

  it('rejects when only a malformed UUID is present', () => {
    const result = shadowBomDeductionBranchIdsSchema.safeParse('12345');
    expect(result.success).toBe(false);
  });
});

describe('computeShadowBomDeductionEnabledForBranch', () => {
  it('is disabled for every branch when the global flag is false, regardless of branch list', () => {
    expect(computeShadowBomDeductionEnabledForBranch(false, [], BRANCH_A)).toBe(false);
    expect(computeShadowBomDeductionEnabledForBranch(false, [BRANCH_A], BRANCH_A)).toBe(false);
  });

  it('is enabled for all branches when the global flag is true and the branch list is empty', () => {
    expect(computeShadowBomDeductionEnabledForBranch(true, [], BRANCH_A)).toBe(true);
    expect(computeShadowBomDeductionEnabledForBranch(true, [], BRANCH_B)).toBe(true);
  });

  it('is enabled for a branch included in a populated branch list', () => {
    expect(computeShadowBomDeductionEnabledForBranch(true, [BRANCH_A, BRANCH_B], BRANCH_A)).toBe(true);
  });

  it('is disabled for a branch excluded from a populated branch list', () => {
    expect(computeShadowBomDeductionEnabledForBranch(true, [BRANCH_A], BRANCH_B)).toBe(false);
  });
});
