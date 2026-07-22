# Changelog

All notable changes to this project are documented in this file.

## 2026-07-22 — Phase 1 (Foundation) of Super Admin Dashboard redesign complete

- **feat(admin):** Branch selector at top of Super Admin dashboard; 7 existing KPIs rewired to be branch-scoped (Steps 1.1 + 1.2)
- **feat(admin):** Full Expenses Module — backend CRUD + frontend list/new/detail pages + receipt upload/delete, audit logged (Step 1.3)
- **feat(admin):** Gross Sales, Expenses, and Net Profit KPIs added to the dashboard, now 10 KPIs total grouped into Financial/Operational sections (Step 1.4)
- **test:** Backend vitest 838 -> 868 (+30), frontend vitest 197 -> 245 (+48) across Phase 1; Playwright E2E production 10 pass / 0 fail / 2 skip
- Live at <https://www.potatorenovare.com>

## 2026-07-22

- **feat(admin):** Discount Audit Report — per-card PWD/Senior fraud log with search, fraud badges, PII decryption (super_admin only), CSV export
- **feat(admin):** Branch Accounts — bulk cross-branch view of all user-branch assignments
- **feat(admin):** Login Audit Report — filtered view of login events with CSV export via existing report pipeline
- **feat(admin):** Enhanced Branch Overview Grid — per-card today's revenue/txn count/staff/low-stock, click-through to branch detail
- **fix(admin):** Employee detail Activity tab now shows real audit log (was placeholder)
- **fix(branches):** `findAllStatsGrouped` no longer drops branches with zero activity today
- **migration:** Add `AUDIT_LOG` to `ReportType` enum (`20260722021611_add_audit_log_report_type`)
