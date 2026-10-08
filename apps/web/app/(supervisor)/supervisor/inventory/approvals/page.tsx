'use client';

import { InventoryApprovalQueue } from '@/components/branch-ops/inventory-approvals/inventory-approval-queue';

export default function SupervisorInventoryApprovalsPage() {
  return <InventoryApprovalQueue basePath="/supervisor" />;
}
