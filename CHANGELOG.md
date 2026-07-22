# Changelog

All notable changes to this project are documented in this file.

## 2026-07-22

- **feat(admin):** Discount Audit Report — per-card PWD/Senior fraud log with search, fraud badges, PII decryption (super_admin only), CSV export
- **feat(admin):** Branch Accounts — bulk cross-branch view of all user-branch assignments
- **feat(admin):** Login Audit Report — filtered view of login events with CSV export via existing report pipeline
- **feat(admin):** Enhanced Branch Overview Grid — per-card today's revenue/txn count/staff/low-stock, click-through to branch detail
- **fix(admin):** Employee detail Activity tab now shows real audit log (was placeholder)
- **fix(branches):** `findAllStatsGrouped` no longer drops branches with zero activity today
- **migration:** Add `AUDIT_LOG` to `ReportType` enum (`20260722021611_add_audit_log_report_type`)
