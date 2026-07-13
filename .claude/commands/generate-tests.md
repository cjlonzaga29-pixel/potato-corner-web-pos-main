Generate a Vitest test suite for a service file, based on its function signatures and the business rules that govern them.

**Purpose:** produce unit tests that verify business correctness (not just that a function runs) — per the project's testing philosophy, a test that verifies the PWD VAT calculation produces the legally correct result is worth far more than one that only checks a function doesn't throw.

**Preconditions:** the service file exists and its business logic is either self-contained or its dependencies (repository calls) can be mocked.

**Steps:**
1. Read the target service file and identify every exported function.
2. Cross-reference `docs/architecture/final-approved-architecture.md` for any formal algorithm or formula the function implements (recipe deduction, PWD/Senior VAT, cash variance, fraud detection rules, offline provisional numbering) — these get edge-case coverage, not just happy-path coverage.
3. Mock the repository layer; the service test should never hit a real database.
4. Write tests covering: the documented happy path, every documented edge case (e.g. flavor-override vs base-only ingredients for the recipe algorithm), and invalid-input rejection.
5. Place the test file alongside the source file as `<name>.test.ts`.
