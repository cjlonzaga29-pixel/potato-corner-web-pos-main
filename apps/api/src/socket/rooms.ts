/** Room-based architecture: every branch has its own room; Super Admin joins all of them. */
export const SUPER_ADMIN_ROOM = 'super_admin';

export function branchRoom(branchId: string): string {
  return `branch:${branchId}`;
}

/** Every socket also joins a room scoped to its own user id, for events (e.g. report export links) that must reach only the requester, not their whole branch. */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}
