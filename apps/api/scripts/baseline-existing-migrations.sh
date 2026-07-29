#!/usr/bin/env bash
#
# Baseline existing Prisma migrations against a database whose schema already
# reflects their cumulative effect, but which has no _prisma_migrations
# history table yet.
#
# This script does NOT alter the database schema. It only calls
# `prisma migrate resolve --applied` for each pre-existing migration, which
# records that migration as already-applied in _prisma_migrations without
# running its SQL.
#
# Target project: nliuhztaezaujzgtsrwp (production-designated, but has
# historically been used as the development/fixture environment — verify
# you are pointed at the intended database before running this).
#
# The pending migration 20260729190000_add_inventory_item_stock_unit_cost is
# intentionally EXCLUDED from this script. It must be applied separately via
# `prisma migrate deploy` after this baseline completes successfully
# (see apps/api/scripts/after-baseline-unit-cost-plan.md).

set -euo pipefail

# ---------------------------------------------------------------------------
# 1. Location guard
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
MIGRATIONS_DIR="${API_DIR}/prisma/migrations"

if [[ ! -f "${API_DIR}/prisma/schema.prisma" ]]; then
  echo "ERROR: expected to find apps/api/prisma/schema.prisma relative to this script." >&2
  echo "This script must be run from within the repository at apps/api/scripts/." >&2
  exit 1
fi

if [[ ! -d "${MIGRATIONS_DIR}" ]]; then
  echo "ERROR: migrations directory not found at ${MIGRATIONS_DIR}" >&2
  exit 1
fi

echo "Repository location verified: ${API_DIR}"
echo "Migrations directory verified: ${MIGRATIONS_DIR}"

# ---------------------------------------------------------------------------
# 2. Explicit safety guards (environment variable confirmation)
# ---------------------------------------------------------------------------

if [[ "${CONFIRM_BASELINE_TARGET:-}" != "nliuhztaezaujzgtsrwp" ]]; then
  echo "ERROR: CONFIRM_BASELINE_TARGET must be set to exactly 'nliuhztaezaujzgtsrwp'." >&2
  echo "This confirms you intend to baseline the Supabase project nliuhztaezaujzgtsrwp." >&2
  echo "WARNING: this project is production-designated, but has historically been" >&2
  echo "used as the development/fixture environment. Confirm the target before proceeding." >&2
  exit 1
fi

if [[ "${CONFIRM_BASELINE:-}" != "yes" ]]; then
  echo "ERROR: CONFIRM_BASELINE must be set to exactly 'yes' to proceed." >&2
  exit 1
fi

echo "WARNING: target project nliuhztaezaujzgtsrwp is production-designated," \
     "but has historically been used as the development/fixture environment."

# ---------------------------------------------------------------------------
# 3. Pre-flight, non-mutating checks
# ---------------------------------------------------------------------------

echo "Running pre-flight check: npx prisma validate"
npx prisma validate --schema="${API_DIR}/prisma/schema.prisma"

echo "Running pre-flight check: npx prisma migrate status"
echo "(All migrations are expected to show as pending here, because no" \
     "_prisma_migrations history exists yet. This is expected and is NOT" \
     "authorization to proceed automatically.)"
npx prisma migrate status --schema="${API_DIR}/prisma/schema.prisma" || true

if [[ "${CONFIRM_SCHEMA_AUDIT_COMPLETE:-}" != "yes" ]]; then
  echo "ERROR: CONFIRM_SCHEMA_AUDIT_COMPLETE must be set to exactly 'yes' to proceed." >&2
  echo "Review the migrate status output above before confirming." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. Resolve each of the 58 pre-existing migrations as applied, explicitly
#    and individually, in chronological order. Each command is written out
#    by name (not generated from a loop over an array or the filesystem) so
#    a human can review every single migration that will be marked applied.
#
#    20260729190000_add_inventory_item_stock_unit_cost is intentionally
#    EXCLUDED below — it is the pending migration, not part of the baseline.
# ---------------------------------------------------------------------------

echo "Baselining migration: 20260709172014_init"
npx prisma migrate resolve --applied "20260709172014_init" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260712122308_add_employee_management_fields"
npx prisma migrate resolve --applied "20260712122308_add_employee_management_fields" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260712210558_cr_001_product_catalog_refactor"
npx prisma migrate resolve --applied "20260712210558_cr_001_product_catalog_refactor" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260714032539_phase8_step1_indexes_and_unique_constraints"
npx prisma migrate resolve --applied "20260714032539_phase8_step1_indexes_and_unique_constraints" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260714033647_phase8_step2_soft_delete_ingredient_recipe"
npx prisma migrate resolve --applied "20260714033647_phase8_step2_soft_delete_ingredient_recipe" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260714120000_phase9_shift_cash_management"
npx prisma migrate resolve --applied "20260714120000_phase9_shift_cash_management" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260714150000_phase10_transactions"
npx prisma migrate resolve --applied "20260714150000_phase10_transactions" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260714160000_phase11_shift_close_summary_fields"
npx prisma migrate resolve --applied "20260714160000_phase11_shift_close_summary_fields" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260715090000_cr_001_soft_delete_branch_recipe_override"
npx prisma migrate resolve --applied "20260715090000_cr_001_soft_delete_branch_recipe_override" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260715120000_phase12_attendance_fields"
npx prisma migrate resolve --applied "20260715120000_phase12_attendance_fields" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260716000000_phase16_report_snapshots"
npx prisma migrate resolve --applied "20260716000000_phase16_report_snapshots" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260716123311_phase17_fraud_detection_hash_and_indexes"
npx prisma migrate resolve --applied "20260716123311_phase17_fraud_detection_hash_and_indexes" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260717000000_phase17_fraud_detection_hash_and_indexes"
npx prisma migrate resolve --applied "20260717000000_phase17_fraud_detection_hash_and_indexes" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260717044127_add_notification_model"
npx prisma migrate resolve --applied "20260717044127_add_notification_model" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260717183937_add_hold_orders"
npx prisma migrate resolve --applied "20260717183937_add_hold_orders" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260719130000_phase21_redis_removal_postgres_backing"
npx prisma migrate resolve --applied "20260719130000_phase21_redis_removal_postgres_backing" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260719140000_phase21_refresh_rotation_cache"
npx prisma migrate resolve --applied "20260719140000_phase21_refresh_rotation_cache" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260719150000_phase21_product_catalog"
npx prisma migrate resolve --applied "20260719150000_phase21_product_catalog" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260721000000_add_vatable_cap_amount"
npx prisma migrate resolve --applied "20260721000000_add_vatable_cap_amount" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260721135130_add_inventory_requests_gcash"
npx prisma migrate resolve --applied "20260721135130_add_inventory_requests_gcash" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260722021611_add_audit_log_report_type"
npx prisma migrate resolve --applied "20260722021611_add_audit_log_report_type" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260722062023_add_expenses_module"
npx prisma migrate resolve --applied "20260722062023_add_expenses_module" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260723034636_add_2fa_fields"
npx prisma migrate resolve --applied "20260723034636_add_2fa_fields" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260723140609_add_system_settings"
npx prisma migrate resolve --applied "20260723140609_add_system_settings" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260723150000_add_branch_payment_method_config"
npx prisma migrate resolve --applied "20260723150000_add_branch_payment_method_config" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260723160000_add_flavor_requests"
npx prisma migrate resolve --applied "20260723160000_add_flavor_requests" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260723170000_add_shift_payment_method_totals"
npx prisma migrate resolve --applied "20260723170000_add_shift_payment_method_totals" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260724000000_add_branch_role_employee_status"
npx prisma migrate resolve --applied "20260724000000_add_branch_role_employee_status" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260724020000_branch_employee_authorization"
npx prisma migrate resolve --applied "20260724020000_branch_employee_authorization" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260724030000_cr_004_recipe_version_and_branch_provisioning"
npx prisma migrate resolve --applied "20260724030000_cr_004_recipe_version_and_branch_provisioning" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260724183216_cr005_product_builder_foundations"
npx prisma migrate resolve --applied "20260724183216_cr005_product_builder_foundations" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260725025000_cr005_backfill_flavor_ingredients"
npx prisma migrate resolve --applied "20260725025000_cr005_backfill_flavor_ingredients" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260725025100_cr005_flavor_ingredient_identity_required"
npx prisma migrate resolve --applied "20260725025100_cr005_flavor_ingredient_identity_required" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260725120000_add_transaction_payment_proof"
npx prisma migrate resolve --applied "20260725120000_add_transaction_payment_proof" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260725190000_branch_permanent_delete_cascade"
npx prisma migrate resolve --applied "20260725190000_branch_permanent_delete_cascade" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260726000000_add_product_inventory_foundation"
npx prisma migrate resolve --applied "20260726000000_add_product_inventory_foundation" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260726120000_remove_product_requests"
npx prisma migrate resolve --applied "20260726120000_remove_product_requests" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260726130000_remove_approval_workflows"
npx prisma migrate resolve --applied "20260726130000_remove_approval_workflows" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260726140000_add_product_inventory_flavor_id"
npx prisma migrate resolve --applied "20260726140000_add_product_inventory_flavor_id" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260726150000_add_transaction_item_deduction_snapshot"
npx prisma migrate resolve --applied "20260726150000_add_transaction_item_deduction_snapshot" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260726160000_add_product_inventory_version"
npx prisma migrate resolve --applied "20260726160000_add_product_inventory_version" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260726170000_add_product_inventory_branch_ownership"
npx prisma migrate resolve --applied "20260726170000_add_product_inventory_branch_ownership" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260726180000_add_product_inventory_soft_delete"
npx prisma migrate resolve --applied "20260726180000_add_product_inventory_soft_delete" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260726235352_drop_legacy_recipe_tables"
npx prisma migrate resolve --applied "20260726235352_drop_legacy_recipe_tables" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260727120000_cr006_phase_a_inventory_foundation"
npx prisma migrate resolve --applied "20260727120000_cr006_phase_a_inventory_foundation" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260727130000_cr006_phase_a_corrective_architecture"
npx prisma migrate resolve --applied "20260727130000_cr006_phase_a_corrective_architecture" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260727140000_cr006_phase_a_final_completion"
npx prisma migrate resolve --applied "20260727140000_cr006_phase_a_final_completion" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260727152357_add_initialization_audit"
npx prisma migrate resolve --applied "20260727152357_add_initialization_audit" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260728084256_cr008_universal_product_catalog_foundation"
npx prisma migrate resolve --applied "20260728084256_cr008_universal_product_catalog_foundation" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260728120000_cr010a_inventory_projection_outbox"
npx prisma migrate resolve --applied "20260728120000_cr010a_inventory_projection_outbox" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260728130000_cr010a2a_projection_claim_token"
npx prisma migrate resolve --applied "20260728130000_cr010a2a_projection_claim_token" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260728140000_cr010a3_inventory_stock_rebuild_watermark"
npx prisma migrate resolve --applied "20260728140000_cr010a3_inventory_stock_rebuild_watermark" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260728150000_cr011a_product_component_bom_foundation"
npx prisma migrate resolve --applied "20260728150000_cr011a_product_component_bom_foundation" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260728160000_cr012_1_shadow_bom_comparison"
npx prisma migrate resolve --applied "20260728160000_cr012_1_shadow_bom_comparison" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260729090000_add_flavor_slot_snack_options"
npx prisma migrate resolve --applied "20260729090000_add_flavor_slot_snack_options" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260729160000_cr011_2_product_component_recipe_unit"
npx prisma migrate resolve --applied "20260729160000_cr011_2_product_component_recipe_unit" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260729170000_product_component_flavor_scope"
npx prisma migrate resolve --applied "20260729170000_product_component_flavor_scope" --schema="${API_DIR}/prisma/schema.prisma"

echo "Baselining migration: 20260729180000_inventory_stock_movement_ledger"
npx prisma migrate resolve --applied "20260729180000_inventory_stock_movement_ledger" --schema="${API_DIR}/prisma/schema.prisma"

echo ""
echo "Baseline complete for 58 migrations."
echo "REMINDER: run 'npx prisma migrate status' now to confirm the database" \
     "reports 58 applied migrations and exactly 1 pending migration" \
     "(20260729190000_add_inventory_item_stock_unit_cost)."
