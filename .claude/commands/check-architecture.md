Review a proposed or implemented feature against the Final Approved Architecture document and identify deviations.

**Purpose:** catch scope creep or spec drift before it merges — this project's architecture documents are the Phase 1 scope boundary; anything not described in them requires a formal change request.

**Preconditions:** the feature touches business logic, schema, or an API contract (purely cosmetic UI changes don't need this check).

**Steps:**
1. Identify which Part/Section of `docs/architecture/final-approved-architecture.md` or `docs/architecture/master-execution-plan.md` governs this feature.
2. Compare the implementation against that section field-by-field for business logic (the recipe algorithm, VAT formula, JWT payload shape, offline receipt numbering, cash variance rules, fraud detection thresholds are the highest-stakes areas to check character-for-character).
3. Flag any new library, pattern, or architectural boundary not already present in the two documents.
4. Flag any state living in the wrong place (server data in Zustand, or browser-only state in TanStack Query).
5. Report deviations with the specific document section they conflict with, ranked by how load-bearing the deviation is (a changed VAT formula is critical; a renamed internal variable is not).
