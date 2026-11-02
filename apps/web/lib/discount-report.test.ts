import { describe, expect, it } from 'vitest';
import type { DiscountComplianceReportRow } from '@potato-corner/shared';
import { discountRowName, discountTypeOptions, mergeDiscountRows, saleDiscountName, saleProofRequirement, summarizeDiscountProof } from './discount-report';

const TYPE_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const TYPE_B = 'bbbbbbbb-1111-4111-8111-111111111111';

function row(overrides: Partial<DiscountComplianceReportRow>): DiscountComplianceReportRow {
  return {
    branch_id: 'branch-1',
    branch_name: 'Main',
    discount_type: 'manual',
    discount_key: `manual:${TYPE_A}`,
    discount_name: 'PWD',
    transaction_count: 1,
    total_discount_amount: 10,
    total_vat_exempt_amount: null,
    proof_required_count: 0,
    proof_available_count: 0,
    proof_missing_count: 0,
    proof_unknown_count: 0,
    ...overrides,
  };
}

describe('saleDiscountName / saleProofRequirement', () => {
  const manual = (name: string, requireProof: boolean) => ({ discount_type: 'manual', manual_discount: { discount_type_id: TYPE_A, name, amount: 5, require_proof: requireProof } }) as const;

  it('uses the name saved on the sale', () => {
    expect(saleDiscountName(manual('PWD', true))).toBe('PWD');
    expect(saleProofRequirement(manual('PWD', true))).toBe('required');
    expect(saleProofRequirement(manual('PWD', false))).toBe('optional');
  });

  it('a manual sale with no saved evidence is honest about it', () => {
    const sale = { discount_type: 'manual', manual_discount: null } as const;
    expect(saleDiscountName(sale)).toBe('Unspecified discount');
    expect(saleProofRequirement(sale)).toBe('unknown');
  });

  it('a sale with no discount has no name', () => {
    expect(saleDiscountName({ discount_type: null, manual_discount: null })).toBeNull();
  });
});

describe('mergeDiscountRows', () => {
  it('merges only the same identity at the same branch, adding up counts and amounts', () => {
    const merged = mergeDiscountRows([
      row({ calculation_mode: 'manual_total_v1', transaction_count: 2, total_discount_amount: 20.1, proof_required_count: 2, proof_available_count: 1, proof_missing_count: 1 }),
      row({ calculation_mode: 'legacy_vat_v1', transaction_count: 1, total_discount_amount: 10.2, proof_required_count: 1, proof_available_count: 1 }),
      row({ branch_id: 'branch-2', branch_name: 'North', discount_key: `manual:${TYPE_B}` }),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ transaction_count: 3, total_discount_amount: 30.3, proof_required_count: 3, proof_available_count: 2, proof_completion_percent: 66.7 });
  });

  it('an older API row with no identity falls back to its stored code, and a manual one is never called Manual', () => {
    const [merged] = mergeDiscountRows([{ branch_id: 'b', branch_name: 'B', discount_type: 'manual', transaction_count: 1, total_discount_amount: 5, total_vat_exempt_amount: null }]);
    expect(merged?.discount_key).toBe('manual:unspecified');
    expect(discountRowName(merged as DiscountComplianceReportRow)).toBe('Unspecified discount');
  });
});

describe('discountTypeOptions', () => {
  it('same-named types at two branches stay separate choices', () => {
    const options = discountTypeOptions([row({}), row({ branch_id: 'branch-2', branch_name: 'North', discount_key: `manual:${TYPE_B}` })]);
    expect(options).toEqual([
      { key: `manual:${TYPE_A}`, label: 'PWD (Main)' },
      { key: `manual:${TYPE_B}`, label: 'PWD (North)' },
    ]);
  });

  it('same-named types at one branch (a type deactivated and recreated) stay separate choices', () => {
    const options = discountTypeOptions([row({}), row({ discount_key: `manual:${TYPE_B}` })]);
    expect(options.map((o) => o.key)).toEqual([`manual:${TYPE_A}`, `manual:${TYPE_B}`]);
    expect(new Set(options.map((o) => o.label)).size).toBe(2);
  });

  it('adds no choice with no sales, and no built-in default', () => {
    expect(discountTypeOptions([])).toEqual([]);
  });
});

describe('summarizeDiscountProof', () => {
  it('counts only sales that required proof in the denominator; unknown stays apart', () => {
    const summary = summarizeDiscountProof([
      row({ proof_required_count: 4, proof_available_count: 3, proof_missing_count: 1 }),
      row({ discount_key: 'type:pwd', proof_unknown_count: 9 }),
      row({ discount_key: 'type:employee', transaction_count: 50 }),
    ]);
    expect(summary).toEqual({ required: 4, available: 3, missing: 1, unknown: 9, completionPercent: 75 });
  });

  it('no sale requiring proof is N/A (null), not 100%', () => {
    expect(summarizeDiscountProof([row({ discount_key: 'type:employee' })]).completionPercent).toBeNull();
    expect(summarizeDiscountProof([]).completionPercent).toBeNull();
  });
});
