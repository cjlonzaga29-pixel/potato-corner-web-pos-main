import { redirect } from 'next/navigation';

/** POS-PERF-P31 — folded into Stock History's "Request History" tab; kept as a compatibility redirect so the old URL keeps working. */
export default function SupervisorInventoryApprovalsPage() {
  redirect('/supervisor/inventory/stock-history?tab=requests');
}
