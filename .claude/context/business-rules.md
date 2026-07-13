# Business Rules Context

These are the rules `.claude/CLAUDE.md` already flags as "never modify without explicit instruction." This file exists to give the *why*, so a deviation is never made by someone who didn't understand the constraint.

## Recipe deduction algorithm

Base ingredients (`flavorId IS NULL`) plus flavor-specific ingredients (`flavorId = selected`), where a flavor-specific row **overrides** — not adds to — a base row for the same `ingredientId`. Multiply by quantity sold, deduct atomically in one transaction, log one `InventoryMovement` per ingredient. Why it's locked: this is a financial-accuracy algorithm signed off by two engineers and a business analyst before Phase 0 began (Final Approved Architecture, Part 16 critical checklist). An implementation bug here means silently wrong inventory counts across every branch.

## PWD / Senior Citizen VAT formula

`VATable base = total ÷ 1.12` → `discount = VATable base × 0.20` → `discounted base = VATable base − discount` → `VAT = discounted base × 0.12` → `final total = discounted base + VAT`. Why it's locked: this is Philippine statutory law (RA 9994 / RA 10754 discount treatment), not a business preference — an incorrect formula is a legal compliance failure, not a bug.

## Transaction number = receipt number

One field, `transaction_number`, used everywhere — POS display, search, audit logs, customer-facing receipts. Why it's locked: introducing a second "receipt number" field would create two sources of truth for the same real-world document, breaking reconciliation and the offline-sync renumbering flow.

## Offline provisional numbering

`PC-[BRANCH_CODE]-[DATE]-OFFLINE-[LOCAL_SEQ]`, per-device daily counter, resets at midnight, replaced by the server-issued official number on sync (chronological order). Why it's locked: this format is what's printed on customer receipts during an outage and referenced in cashier training material — changing it after pilot launch means retraining staff and confusing customers holding an old-format receipt.

## JWT payload shape

`super_admin` has no `branch_ids`; `supervisor` has an array (possibly >1 branch); `staff` has an array of exactly 1. Why it's locked: every branch-authorization check in `apps/api/src/middleware/branch-guard.ts` assumes this exact shape — widening or narrowing it silently changes who can access what.

## Discount precedence

Only one discount per transaction. PWD/Senior (statutory) always wins over a simultaneous promotional discount — they're never combined. Why: statutory discounts are a legal entitlement that can't be reduced by a business promotion; combining them would under- or over-apply a discount the law specifies exactly.
