import { describe, expect, it } from 'vitest';
import {
  discountDisplayName,
  discountIdentityKey,
  discountKeySchema,
  discountProofRequirement,
  discountReceiptLabel,
  parseDiscountKey,
  proofCompletionPercent,
  readManualDiscountEvidence,
  UNSPECIFIED_DISCOUNT_LABEL,
} from './discount-display.js';
import { reportTypeDisplayName } from '../schemas/reports.schema.js';

const TYPE_ID = '11111111-1111-4111-8111-111111111111';

describe('discountDisplayName', () => {
  it('a manual sale shows its saved name, whatever that name is', () => {
    expect(discountDisplayName('manual', 'PWD')).toBe('PWD');
    expect(discountDisplayName('manual', 'Loyalty')).toBe('Loyalty');
  });

  it('never reads "Manual": a missing or blank name is honest', () => {
    expect(discountDisplayName('manual', null)).toBe(UNSPECIFIED_DISCOUNT_LABEL);
    expect(discountDisplayName('manual', undefined)).toBe(UNSPECIFIED_DISCOUNT_LABEL);
    expect(discountDisplayName('manual', '   ')).toBe(UNSPECIFIED_DISCOUNT_LABEL);
  });

  it('keeps historical statutory and built-in labels', () => {
    expect(discountDisplayName('pwd')).toBe('PWD');
    expect(discountDisplayName('senior_citizen')).toBe('Senior Citizen');
    expect(discountDisplayName('employee')).toBe('Employee');
    expect(discountDisplayName('manager_override')).toBe('Manager Override');
    expect(discountDisplayName('promotional')).toBe('Promotional');
  });

  it('a code this build does not know is unspecified, not its raw code', () => {
    expect(discountDisplayName('future_code')).toBe(UNSPECIFIED_DISCOUNT_LABEL);
  });

  it('no discount has no name', () => {
    expect(discountDisplayName(null)).toBeNull();
  });
});

describe('discountReceiptLabel', () => {
  it('manual: the saved name, without doubling the word discount', () => {
    expect(discountReceiptLabel('manual', 'PWD', null)).toBe('PWD discount');
    expect(discountReceiptLabel('manual', 'Senior Discount', null)).toBe('Senior Discount');
  });

  it('built-in: the rate frozen on the sale', () => {
    expect(discountReceiptLabel('pwd', null, 20)).toBe('PWD Discount (20%)');
    expect(discountReceiptLabel('employee', null, null)).toBe('Employee Discount');
  });

  it('nothing readable: plain Discount', () => {
    expect(discountReceiptLabel('manual', null, null)).toBe('Discount');
    expect(discountReceiptLabel('future_code', null, null)).toBe('Discount');
  });
});

describe('readManualDiscountEvidence', () => {
  it('reads a saved snapshot', () => {
    expect(readManualDiscountEvidence({ discount_type_id: TYPE_ID, name: ' PWD ', require_proof: true })).toEqual({ discount_type_id: TYPE_ID, name: 'PWD', require_proof: true });
  });

  it('tolerates missing or malformed snapshots', () => {
    for (const bad of [null, undefined, 'x', 3]) expect(readManualDiscountEvidence(bad)).toEqual({ discount_type_id: null, name: null, require_proof: null });
    expect(readManualDiscountEvidence({ name: 42, require_proof: 'yes' })).toEqual({ discount_type_id: null, name: null, require_proof: null });
  });
});

describe('discountProofRequirement', () => {
  it('manual: exactly what the sale saved', () => {
    expect(discountProofRequirement('manual', true)).toBe('required');
    expect(discountProofRequirement('manual', false)).toBe('optional');
    expect(discountProofRequirement('manual', null)).toBe('unknown');
  });

  it('PWD/Senior from the older checkout: unknown, since that checkout never enforced proof', () => {
    expect(discountProofRequirement('pwd', null)).toBe('unknown');
    expect(discountProofRequirement('senior_citizen', null)).toBe('unknown');
  });

  it('types that could never carry proof are not required', () => {
    expect(discountProofRequirement('employee', null)).toBe('optional');
    expect(discountProofRequirement('promotional', null)).toBe('optional');
  });
});

describe('discount identity', () => {
  it('a manual sale is its type id; anything else its code; never a name', () => {
    expect(discountIdentityKey('manual', TYPE_ID)).toBe(`manual:${TYPE_ID}`);
    expect(discountIdentityKey('manual', null)).toBe('manual:unspecified');
    expect(discountIdentityKey('pwd', null)).toBe('type:pwd');
  });

  it('round-trips through the parser', () => {
    expect(parseDiscountKey(`manual:${TYPE_ID}`)).toEqual({ discountType: 'manual', manualTypeId: TYPE_ID });
    expect(parseDiscountKey('manual:unspecified')).toEqual({ discountType: 'manual', manualTypeId: null });
    expect(parseDiscountKey('type:pwd')).toEqual({ discountType: 'pwd' });
  });

  it('refuses anything else', () => {
    for (const bad of ['', 'PWD', 'manual:', 'manual:not-a-uuid', 'type:', 'type:DROP TABLE', 'type:pwd;x']) {
      expect(discountKeySchema.safeParse(bad).success, bad).toBe(false);
      expect(parseDiscountKey(bad), bad).toBeNull();
    }
  });
});

describe('proofCompletionPercent', () => {
  it('over required sales only', () => {
    expect(proofCompletionPercent(4, 3)).toBe(75);
    expect(proofCompletionPercent(3, 2)).toBe(66.7);
    expect(proofCompletionPercent(2, 2)).toBe(100);
    expect(proofCompletionPercent(2, 0)).toBe(0);
  });

  it('none required is N/A, never 100', () => {
    expect(proofCompletionPercent(0, 0)).toBeNull();
  });
});

describe('reportTypeDisplayName', () => {
  it('renames only the user-facing name', () => {
    expect(reportTypeDisplayName('DISCOUNT_COMPLIANCE')).toBe('Discount Report');
    expect(reportTypeDisplayName('DAILY_SALES')).toBe('Daily Sales Report (DSR)');
    expect(reportTypeDisplayName('VOID_REFUND')).toBe('Void Refund Report');
  });
});
