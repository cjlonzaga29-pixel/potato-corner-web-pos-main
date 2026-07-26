import { describe, it, expect } from 'vitest';
import { createProductInventorySchema } from './product-inventory.schema.js';

const VALID_INPUT = {
  branch_id: 'branch-1',
  product_variant_id: '11111111-1111-4111-8111-111111111111',
  ingredient_id: '22222222-2222-4222-8222-222222222222',
  quantity_required: 2.5,
  unit: 'g',
};

describe('createProductInventorySchema', () => {
  it('accepts a payload with a valid branch_id', () => {
    const result = createProductInventorySchema.safeParse(VALID_INPUT);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branch_id).toBe('branch-1');
    }
  });

  it('rejects a payload missing branch_id', () => {
    const { branch_id, ...withoutBranchId } = VALID_INPUT;
    void branch_id;

    const result = createProductInventorySchema.safeParse(withoutBranchId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'branch_id')).toBe(true);
    }
  });

  it('rejects an empty-string branch_id', () => {
    const result = createProductInventorySchema.safeParse({ ...VALID_INPUT, branch_id: '' });

    expect(result.success).toBe(false);
  });

  it('preserves existing field validation — rejects a non-positive quantity_required', () => {
    const result = createProductInventorySchema.safeParse({ ...VALID_INPUT, quantity_required: 0 });

    expect(result.success).toBe(false);
  });

  it('preserves existing field validation — rejects a missing unit', () => {
    const { unit, ...withoutUnit } = VALID_INPUT;
    void unit;

    const result = createProductInventorySchema.safeParse(withoutUnit);

    expect(result.success).toBe(false);
  });
});
