import { redirect } from 'next/navigation';

/**
 * POS-PERF-P40 — the Admin Employees list became Supervisors. Staff are
 * managed in the Supervisor console. Individual records stay at
 * /admin/employees/[employeeId] (unchanged), so existing deep links to a
 * person keep working; only the list URL redirects.
 */
export default function EmployeesRedirectPage(): never {
  redirect('/admin/supervisors');
}
