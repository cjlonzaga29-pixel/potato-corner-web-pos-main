'use client';

import { ShadowBomDeductionReport } from '@/components/shared/shadow-bom-deduction/shadow-bom-deduction-report';

/**
 * CR-012.1A — Super Admin-only read-only Shadow BOM Deduction dashboard.
 * No mutation controls; nothing here can rerun, edit, delete, or override a
 * comparison, and nothing here affects POS deduction or inventory.
 */
export default function AdminShadowBomDeductionPage() {
  return <ShadowBomDeductionReport />;
}
