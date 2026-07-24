# Architecture Decision Records

Records of decisions made during implementation that go beyond what the two locked specification documents dictate — e.g. specific library versions, forks, or trade-offs chosen when the spec left a detail ambiguous.

The Phase 0 version/package decisions (Zod v4, Express 5, `@ducanh2912/next-pwa` fork, Tailwind v3, native Prisma enums, app-layer AES-256-GCM for government ID fields) are recorded inline in `docs/architecture/database-schema.md` and in the Phase 0 plan; a dedicated ADR-per-decision file can be split out here as the pattern is needed.

- [CR-004 — POS Deduction Integrity & Branch Provisioning](CR-004-pos-deduction-integrity.md) — cross-branch ingredient resolution, recipe versioning, idempotent branch provisioning, InventoryMovement/Transaction immutability enforcement.
- [CR-005 — Product Builder & Recipe Composition Engine](CR-005-product-builder-recipe-composition.md) — composition-driven product/recipe builder, per-flavor ingredient rows, DRAFT/PENDING_APPROVAL/ACTIVE/ARCHIVED lifecycle, recipe versioning on edit. Proposed.
