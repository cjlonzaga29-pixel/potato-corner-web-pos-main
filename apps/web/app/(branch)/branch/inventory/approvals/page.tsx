'use client';

import { InventoryApprovalQueue } from '@/components/branch-ops/inventory-approvals/inventory-approval-queue';

export default function BranchInventoryApprovalsPage() {
  return <InventoryApprovalQueue basePath="/branch" />;
}
