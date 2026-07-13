/** Room-based architecture: every branch has its own room; Super Admin joins all of them. */
export const SUPER_ADMIN_ROOM = 'super_admin';

export function branchRoom(branchId: string): string {
  return `branch:${branchId}`;
}
