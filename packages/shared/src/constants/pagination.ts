/**
 * Server-enforced ceiling for any paginated list endpoint's `limit` query
 * param. A frontend request above this is rejected with a 422 — this
 * constant is the single source of truth for that ceiling on both sides,
 * so a request builder can't drift out of sync with the Zod schema that
 * validates it (as reports.schema.ts's ReportFiltersSchema and
 * branches.router.ts's listQuerySchema both did before this constant
 * existed, causing dashboard/report widgets to 422 and render as errors
 * or zeroed-out totals).
 */
export const MAX_LIST_LIMIT = 100;
