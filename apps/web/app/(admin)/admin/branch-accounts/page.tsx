import { redirect } from 'next/navigation';

/**
 * POS-PERF-P40 — Branch Accounts was merged into Branches (Branch Account
 * column + Manage → Account). Old links and bookmarks land on the combined
 * list. middleware.ts still enforces the /admin role prefix before this runs.
 */
export default function BranchAccountsRedirectPage(): never {
  redirect('/admin/branches');
}
