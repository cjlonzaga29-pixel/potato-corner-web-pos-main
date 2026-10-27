import { describe, it, expect } from 'vitest';
import { groupNotifications, type GroupableNotification } from './notification-groups';

function n(id: string, type: string, branchId: string, minutesAgo: number, overrides: Partial<GroupableNotification> = {}): GroupableNotification {
  return {
    id,
    type,
    branchId,
    subjectKey: '',
    createdAt: new Date(Date.UTC(2026, 9, 27, 12, 0) - minutesAgo * 60_000).toISOString(),
    read: false,
    ...overrides,
  };
}

describe('groupNotifications', () => {
  it('folds repeated offline alerts for the same branch into one group, keeping every item', () => {
    const groups = groupNotifications([n('a', 'branch_offline', 'b1', 1), n('b', 'branch_offline', 'b1', 5), n('c', 'branch_offline', 'b1', 9)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(groups[0]?.unreadCount).toBe(3);
    expect(groups[0]?.recoveredBy).toBeNull();
  });

  it('keeps outages at different branches separate', () => {
    const groups = groupNotifications([n('a', 'branch_offline', 'b1', 1), n('b', 'branch_offline', 'b2', 2)]);
    expect(groups).toHaveLength(2);
  });

  it('splits separate incidents at a recovery and attributes each recovery to the outage before it', () => {
    // Newest first: online(5) closes incident [offline(10), offline(12)]; online(20) closes [offline(30)].
    const groups = groupNotifications([
      n('on2', 'branch_online', 'b1', 5),
      n('off3', 'branch_offline', 'b1', 10),
      n('off2', 'branch_offline', 'b1', 12),
      n('on1', 'branch_online', 'b1', 20),
      n('off1', 'branch_offline', 'b1', 30),
    ]);
    const outages = groups.filter((g) => g.latest.type === 'branch_offline');
    expect(outages).toHaveLength(2);
    expect(outages[0]?.items.map((i) => i.id)).toEqual(['off3', 'off2']);
    expect(outages[0]?.recoveredBy?.id).toBe('on2');
    expect(outages[1]?.items.map((i) => i.id)).toEqual(['off1']);
    expect(outages[1]?.recoveredBy?.id).toBe('on1');
  });

  it('never claims recovery without a newer branch_online', () => {
    const groups = groupNotifications([n('off', 'branch_offline', 'b1', 1), n('on-old', 'branch_online', 'b1', 60)]);
    const outage = groups.find((g) => g.latest.type === 'branch_offline');
    expect(outage?.recoveredBy).toBeNull();
  });

  it('groups stock alerts per ingredient, not across ingredients', () => {
    const groups = groupNotifications([
      n('a', 'low_stock', 'b1', 1, { subjectKey: 'Potato' }),
      n('b', 'low_stock', 'b1', 2, { subjectKey: 'Cheese' }),
      n('c', 'low_stock', 'b1', 3, { subjectKey: 'Potato' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('never groups ordinary events such as sales', () => {
    const groups = groupNotifications([n('a', 'sale_completed', 'b1', 1), n('b', 'sale_completed', 'b1', 2)]);
    expect(groups).toHaveLength(2);
  });

  it('counts only unread items in a group', () => {
    const groups = groupNotifications([n('a', 'branch_offline', 'b1', 1, { read: true }), n('b', 'branch_offline', 'b1', 2)]);
    expect(groups[0]?.unreadCount).toBe(1);
  });
});
