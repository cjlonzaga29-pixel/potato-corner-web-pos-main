# CR-010 — VAT retired as an active feature

**Status:** Implemented on `feat/pos-perf-p62-performance-and-reliability` (POS-PERF-P63). **Date:** 2026-11-21. **Decided by:** the business owner.

## Decision

VAT is removed as an active feature, permanently. This is not a label change: the calculation and configuration paths are gone for new sales.

- Every new sale is **subtotal − the applicable discount = amount to pay**. Nothing is extracted, added or exempted.
- The statutory PWD/Senior Citizen formula (architecture doc "PWD/Senior Citizen VAT formula") no longer runs for any new sale.
- A supervisor-created discount type named "PWD" (or anything else) is an ordinary manual or fixed peso discount, with that type's eligibility, amount limit and proof rules. Its name never selects a formula.
- There is no VAT setting, VAT rate editor, statutory-rate editor or VAT-registration screen or write endpoint.

## What is preserved

- **History is not rewritten.** Stored totals, `vat_amount`, `vat_exempt_amount`, `tax_snapshot`, `calculation_mode` (NULL still means the legacy VAT calculation), refunds, voids, receipts' stored basis and audit records stay exactly as recorded. Nothing is recalculated with the new formula, and no column or table is dropped.
- Historical readers (receipt detail, reports, the discount report) keep reading stored values. Normal screens and exports show no VAT, as since P59.
- Supervisor-created discount names, proof photos, amounts and history are unchanged.

## Enforcement

Server-side, in `transactionsService.createTransaction` (`assertVatCalculationRetired`). It runs after both replay paths (idempotency key and offline device identity), so an already-recorded sale of any calculation still replays with its stored amounts. A **new** sale that is not the manual-flow manual total (an older POS's checkout, or the statutory PWD/Senior shape) is refused with `VAT_CALCULATION_RETIRED` (422), nothing written. It is never repriced. The client flag alone is not trusted.

## Supersedes

- `final-approved-architecture.md` — "PWD/Senior Citizen VAT formula" and the PWD/Senior/Employee/Promotional rules under **Discounts**, for new sales. They remain the description of how historical sales were calculated.
- `.claude/CLAUDE.md` — "PWD/Senior Citizen VAT Formula" critical rule, likewise.

Details, compatibility and rollout: [`../runbooks/pos-perf-p63-vat-retired.md`](../runbooks/pos-perf-p63-vat-retired.md).
