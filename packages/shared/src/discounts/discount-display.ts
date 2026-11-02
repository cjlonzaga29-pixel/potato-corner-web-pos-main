import { z } from 'zod';
import { MANUAL_DISCOUNT_TYPE } from '../schemas/manual-discount.schema.js';

/**
 * POS-PERF-P59 — how every report, receipt and export names a sale's discount,
 * groups it, and decides whether it needed proof. Rules live in
 * docs/runbooks/pos-perf-p59-reports-and-ui-cleanup.md.
 *
 * Everything here reads what was saved on the sale, never the current type:
 * a renamed or deactivated type cannot change a past sale's name, and today's
 * "require proof" setting cannot change whether a past sale needed proof.
 */

/** A manual sale with no readable saved name, or a code this build does not know. Honest, never a guess. */
export const UNSPECIFIED_DISCOUNT_LABEL = 'Unspecified discount';

/** Names of the codes written before custom types existed. Historical labels only: not choices offered at checkout. */
const BUILT_IN_DISCOUNT_NAMES: Readonly<Record<string, string>> = {
  pwd: 'PWD',
  senior_citizen: 'Senior Citizen',
  employee: 'Employee',
  manager_override: 'Manager Override',
  promotional: 'Promotional',
};

export interface ManualDiscountEvidence {
  discount_type_id: string | null;
  name: string | null;
  /** Null when the snapshot does not say. */
  require_proof: boolean | null;
}

/** The fields of transactions.manual_discount_snapshot reports read, tolerating a missing or malformed one. */
export function readManualDiscountEvidence(snapshot: unknown): ManualDiscountEvidence {
  if (typeof snapshot !== 'object' || snapshot === null) return { discount_type_id: null, name: null, require_proof: null };
  const record = snapshot as { discount_type_id?: unknown; name?: unknown; require_proof?: unknown };
  const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : null;
  return {
    discount_type_id: typeof record.discount_type_id === 'string' ? record.discount_type_id : null,
    name,
    require_proof: typeof record.require_proof === 'boolean' ? record.require_proof : null,
  };
}

/** The name to show for a sale's discount; null when the sale has no discount. "Manual" is never a name. */
export function discountDisplayName(discountType: string | null | undefined, manualName?: string | null): string | null {
  if (!discountType) return null;
  if (discountType === MANUAL_DISCOUNT_TYPE) return manualName?.trim() || UNSPECIFIED_DISCOUNT_LABEL;
  return BUILT_IN_DISCOUNT_NAMES[discountType] ?? UNSPECIFIED_DISCOUNT_LABEL;
}

/** The receipt line for a discount. A built-in type keeps the rate frozen on the sale, never today's setting. */
export function discountReceiptLabel(discountType: string | null | undefined, manualName: string | null | undefined, rateUsed: number | null | undefined): string {
  const name = discountDisplayName(discountType, manualName);
  if (!name || name === UNSPECIFIED_DISCOUNT_LABEL) return 'Discount';
  if (discountType === MANUAL_DISCOUNT_TYPE) return /\bdiscount\b/i.test(name) ? name : `${name} discount`;
  return rateUsed != null ? `${name} Discount (${rateUsed}%)` : `${name} Discount`;
}

/**
 * - required / optional: the sale saved that answer (manual snapshot), or could
 *   never carry proof at all (employee, promotional, manager override).
 * - unknown: nothing saved says. Includes PWD/Senior sales from the older
 *   checkout, which never enforced proof, and manual sales with no snapshot.
 *
 * Only 'required' counts toward proof completion.
 */
export const DISCOUNT_PROOF_REQUIREMENTS = ['required', 'optional', 'unknown'] as const;
export type DiscountProofRequirement = (typeof DISCOUNT_PROOF_REQUIREMENTS)[number];

export function discountProofRequirement(discountType: string | null | undefined, manualRequireProof: boolean | null | undefined): DiscountProofRequirement {
  if (discountType === MANUAL_DISCOUNT_TYPE) {
    if (manualRequireProof === true) return 'required';
    if (manualRequireProof === false) return 'optional';
    return 'unknown';
  }
  if (discountType === 'pwd' || discountType === 'senior_citizen') return 'unknown';
  return 'optional';
}

export const DISCOUNT_PROOF_REQUIREMENT_LABELS: Readonly<Record<DiscountProofRequirement, string>> = {
  required: 'Required',
  optional: 'Not required',
  unknown: 'Unknown',
};

const UNSPECIFIED_MANUAL_KEY = 'manual:unspecified';

/**
 * The identity a discount is grouped and filtered by: a manual sale by its
 * type's id (each branch has its own row, so same-named types at two branches
 * stay apart), anything else by its code. Never by name.
 */
export function discountIdentityKey(discountType: string, manualTypeId: string | null | undefined): string {
  if (discountType === MANUAL_DISCOUNT_TYPE) return manualTypeId ? `manual:${manualTypeId}` : UNSPECIFIED_MANUAL_KEY;
  return `type:${discountType}`;
}

export const discountKeySchema = z.string().regex(/^(manual:(unspecified|[0-9a-fA-F-]{36})|type:[a-z_]{1,40})$/, 'Unknown discount type');

export type ParsedDiscountKey = { discountType: string; manualTypeId?: string | null };

/** Null for a value discountKeySchema would refuse. manualTypeId null means a manual sale with no saved type. */
export function parseDiscountKey(key: string): ParsedDiscountKey | null {
  if (!discountKeySchema.safeParse(key).success) return null;
  if (key === UNSPECIFIED_MANUAL_KEY) return { discountType: MANUAL_DISCOUNT_TYPE, manualTypeId: null };
  if (key.startsWith('manual:')) return { discountType: MANUAL_DISCOUNT_TYPE, manualTypeId: key.slice('manual:'.length) };
  return { discountType: key.slice('type:'.length) };
}

/** Proof completion over sales that required proof. Null means N/A: none did, so there is no percentage to report. */
export function proofCompletionPercent(requiredCount: number, availableCount: number): number | null {
  if (requiredCount <= 0) return null;
  return Math.round((availableCount / requiredCount) * 1000) / 10;
}
