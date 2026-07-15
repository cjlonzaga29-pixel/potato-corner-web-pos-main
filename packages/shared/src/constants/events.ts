/** WebSocket event name constants — shared verbatim between Socket.io server and client. */
export const SOCKET_EVENTS = {
  TRANSACTION_COMPLETED: 'transaction:completed',
  INVENTORY_LOW_STOCK: 'inventory:low_stock',
  INVENTORY_OUT_OF_STOCK: 'inventory:out_of_stock',
  INVENTORY_PRODUCT_UNAVAILABLE: 'inventory:product_unavailable',
  CASH_VARIANCE_FLAGGED: 'cash:variance_flagged',
  // Phase 13 — shift lifecycle broadcasts; not in the original architecture
  // doc's event list (which predates the real-time layer being built out),
  // added here because openShift/closeShift had no event to wire into.
  SHIFT_OPENED: 'cash:shift_opened',
  SHIFT_CLOSED: 'cash:shift_closed',
  VOID_REQUESTED: 'void:requested',
  VOID_APPROVED: 'void:approved',
  ATTENDANCE_CLOCKED_IN: 'attendance:clocked_in',
  ATTENDANCE_CLOCKED_OUT: 'attendance:clocked_out',
  FRAUD_ALERT_CREATED: 'fraud:alert_created',
  BRANCH_STATUS_CHANGED: 'branch:status_changed',
  BRANCH_SUPERVISOR_ASSIGNED: 'branch:supervisor_assigned',
  BRANCH_SUPERVISOR_REMOVED: 'branch:supervisor_removed',

  // CR-001 — approval workflow notifications
  PRODUCT_REQUEST_SUBMITTED: 'product_request:submitted',
  PRODUCT_REQUEST_REVIEWED: 'product_request:reviewed',
  PRICE_OVERRIDE_SUBMITTED: 'price_override:submitted',
  PRICE_OVERRIDE_REVIEWED: 'price_override:reviewed',
} as const;

export type SocketEvent = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];
