/**
 * POS-PERF-P40 — groups repeated alerts in the notification list without
 * merging or deleting the underlying notifications: every grouped item stays
 * available (expandable) and keeps its own read state and history.
 *
 * Grouping key: same type + same branch + same subject (e.g. the same
 * ingredient for stock alerts). Outages are grouped per incident: a
 * `branch_online` for a branch closes that branch's open `branch_offline`
 * group, so an older offline alert starts a separate incident instead of
 * being folded into a newer one. A group shows "recovered" only when an
 * actual `branch_online` notification newer than the outage exists.
 */

export interface GroupableNotification {
  id: string;
  type: string;
  branchId: string;
  /** Distinguishes alerts of the same type at the same branch, e.g. the ingredient name. Empty when not applicable. */
  subjectKey: string;
  createdAt: string;
  read: boolean;
}

export interface NotificationGroup<T extends GroupableNotification> {
  key: string;
  /** Newest first, as received. */
  items: T[];
  latest: T;
  unreadCount: number;
  /** For branch_offline groups only: the newer branch_online that ended this incident, if one was received. */
  recoveredBy: T | null;
}

/** Types whose repeats are worth collapsing. Everything else is always shown individually. */
const GROUPABLE_TYPES = new Set(['branch_offline', 'low_stock', 'critical_stock', 'out_of_stock', 'discount_compliance_flagged', 'inventory_deduction_failed']);

/**
 * `notifications` must be sorted newest first (the API's order). Output keeps
 * that order, positioned by each group's newest item.
 */
export function groupNotifications<T extends GroupableNotification>(notifications: readonly T[]): NotificationGroup<T>[] {
  const groups: NotificationGroup<T>[] = [];
  const openGroupByKey = new Map<string, NotificationGroup<T>>();
  /** Newest branch_online per branch seen so far (i.e. newer than anything processed after it). */
  const recoveryByBranch = new Map<string, T>();

  for (const notification of notifications) {
    if (notification.type === 'branch_online') {
      // Closes the open outage group for this branch: older offline alerts belong to an earlier incident.
      openGroupByKey.delete(`branch_offline|${notification.branchId}|`);
      recoveryByBranch.set(notification.branchId, notification);
    }

    if (!GROUPABLE_TYPES.has(notification.type)) {
      groups.push({ key: notification.id, items: [notification], latest: notification, unreadCount: notification.read ? 0 : 1, recoveredBy: null });
      continue;
    }

    const key = `${notification.type}|${notification.branchId}|${notification.subjectKey}`;
    const open = openGroupByKey.get(key);
    if (open) {
      open.items.push(notification);
      if (!notification.read) open.unreadCount += 1;
      continue;
    }

    const recoveredBy = notification.type === 'branch_offline' ? (recoveryByBranch.get(notification.branchId) ?? null) : null;
    // Each recovery event closes exactly one incident.
    if (recoveredBy) recoveryByBranch.delete(notification.branchId);
    const group: NotificationGroup<T> = {
      key: `${key}|${notification.id}`,
      items: [notification],
      latest: notification,
      unreadCount: notification.read ? 0 : 1,
      recoveredBy,
    };
    openGroupByKey.set(key, group);
    groups.push(group);
  }

  return groups;
}
