/** WebSocket event name constants — shared verbatim between Socket.io server and client. */
export const SOCKET_EVENTS = {
  TRANSACTION_COMPLETED: 'transaction:completed',
  TRANSACTION_REFUNDED: 'transaction:refunded',
  INVENTORY_LOW_STOCK: 'inventory:low_stock',
  INVENTORY_OUT_OF_STOCK: 'inventory:out_of_stock',
  INVENTORY_PRODUCT_UNAVAILABLE: 'inventory:product_unavailable',
  // Phase 7 realtime pass — stock-in/adjust/waste/count/transfer previously
  // only broadcast when crossing a low-stock threshold; other sessions
  // viewing the movement ledger for the same branch never learned of a
  // movement that didn't cross that threshold.
  INVENTORY_MOVEMENT_RECORDED: 'inventory:movement_recorded',
  CASH_VARIANCE_FLAGGED: 'cash:variance_flagged',
  CASH_VARIANCE_APPROVED: 'cash:variance_approved',
  // Phase 13 — shift lifecycle broadcasts; not in the original architecture
  // doc's event list (which predates the real-time layer being built out),
  // added here because openShift/closeShift had no event to wire into.
  SHIFT_OPENED: 'cash:shift_opened',
  SHIFT_CLOSED: 'cash:shift_closed',
  VOID_REQUESTED: 'void:requested',
  VOID_APPROVED: 'void:approved',
  // Phase 20 — non-blocking toast trigger for hold-order expiry (architecture
  // doc §Part 8: 15-min expiry, no supervisor action required).
  HOLD_ORDER_EXPIRED: 'hold_order:expired',
  ATTENDANCE_CLOCKED_IN: 'attendance:clocked_in',
  ATTENDANCE_CLOCKED_OUT: 'attendance:clocked_out',
  FRAUD_ALERT_CREATED: 'fraud:alert_created',
  // Phase 18 — notification types with no other socket event to reuse.
  LARGE_ADJUSTMENT_APPROVAL_NEEDED: 'notification:large_adjustment_approval_needed',
  OFFLINE_TRANSACTIONS_SYNCED: 'notification:offline_transactions_synced',
  EOD_SUMMARY: 'notification:eod_summary',
  // Phase 17 review workflow — not emitted yet (fraud.service.ts's
  // investigate/dismiss/escalate actions are silent by design, see that
  // module's notes), reserved here for whichever future change wires up
  // live broadcasts for them.
  FRAUD_ALERT_INVESTIGATED: 'fraud:alert_investigated',
  FRAUD_ALERT_DISMISSED: 'fraud:alert_dismissed',
  FRAUD_ALERT_ESCALATED: 'fraud:alert_escalated',
  // Phase 17 — emitted by fraud.queue.ts's failed handler after the final
  // retry attempt of a nightly_scan or manual_scan job is exhausted.
  FRAUD_SCAN_FAILED: 'fraud:scan_failed',
  BRANCH_CREATED: 'branch:created',
  BRANCH_STATUS_CHANGED: 'branch:status_changed',
  BRANCH_SUPERVISOR_ASSIGNED: 'branch:supervisor_assigned',
  BRANCH_SUPERVISOR_REMOVED: 'branch:supervisor_removed',
  // Realtime-sync pass — connection-presence based (no staff socket
  // connected to a branch's room for OFFLINE_DEBOUNCE_MS), not a hardware/
  // network-level signal. See socket/presence.ts.
  BRANCH_OFFLINE: 'branch:offline',
  BRANCH_ONLINE: 'branch:online',

  // CR-001 — approval workflow notifications
  PRODUCT_REQUEST_SUBMITTED: 'product_request:submitted',
  PRODUCT_REQUEST_REVIEWED: 'product_request:reviewed',
  PRICE_OVERRIDE_SUBMITTED: 'price_override:submitted',
  PRICE_OVERRIDE_REVIEWED: 'price_override:reviewed',

  // CR-002 — flavor request approval workflow notifications
  FLAVOR_REQUEST_SUBMITTED: 'flavor_request:submitted',
  FLAVOR_REQUEST_REVIEWED: 'flavor_request:reviewed',

  // Phase 16 — report export lifecycle (async CSV/PDF jobs)
  REPORT_EXPORT_READY: 'report:export_ready',
  REPORT_EXPORT_FAILED: 'report:export_failed',

  INVENTORY_REQUEST_SUBMITTED: 'inventory_request:submitted',
  INVENTORY_REQUEST_APPROVED: 'inventory_request:approved',
  INVENTORY_REQUEST_REJECTED: 'inventory_request:rejected',

  // Phase 7 realtime pass — expense ledger had no socket coverage at all.
  EXPENSE_CREATED: 'expense:created',
  EXPENSE_UPDATED: 'expense:updated',
  EXPENSE_DELETED: 'expense:deleted',
} as const;

export type SocketEvent = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];
