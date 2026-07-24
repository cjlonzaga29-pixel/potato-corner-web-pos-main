'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, User } from 'lucide-react';
import { ROLES } from '@potato-corner/shared';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { SearchInput } from '@/components/shared/forms/search-input';
import { useAuth } from '@/hooks/use-auth';
import { useEmployees } from '@/hooks/queries/use-employees';

/**
 * Branch Employee Authorization: the screen a `branch` (Branch Account)
 * session lands on after login. The account itself is already
 * authenticated — this only lists this branch's ACTIVE Employees (`staff`)
 * and lets one be selected to operate the branch, per the locked
 * authentication flow (branch login -> employee selected/validated ->
 * belongs-to-branch + ACTIVE + permission checks server-side -> access
 * granted).
 */
export default function SelectEmployeePage() {
  const router = useRouter();
  const { user, selectEmployee } = useAuth();
  const [search, setSearch] = useState('');
  const [selectingId, setSelectingId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useEmployees({
    role: ROLES.STAFF,
    isActive: true,
    search: search || undefined,
    limit: 100,
  });

  useEffect(() => {
    // A staff session (already selected) has nothing to pick — send it straight in.
    if (user?.role === ROLES.STAFF) {
      router.replace('/branch/dashboard');
    }
  }, [user?.role, router]);

  async function handleSelect(employeeId: string) {
    setSelectingId(employeeId);
    try {
      await selectEmployee(employeeId);
      router.push('/branch/dashboard');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start employee session');
      setSelectingId(null);
    }
  }

  if (user?.role !== ROLES.BRANCH) {
    return null;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Who&apos;s working?</h1>
        <p className="text-sm text-muted-foreground">Select yourself to start operating this branch.</p>
      </div>

      <SearchInput value={search} onChange={setSearch} placeholder="Search by name..." />

      {isLoading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      ) : isError ? (
        <ErrorState title="Failed to load employees" retry={() => void refetch()} />
      ) : (data?.employees.length ?? 0) === 0 ? (
        <EmptyState
          icon={User}
          title="No active employees"
          description="No active employees are assigned to this branch yet. Create one from the Employees section."
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {data?.employees.map((employee) => (
            <Card
              key={employee.id}
              className="cursor-pointer transition-colors hover:border-primary"
              onClick={() => selectingId === null && void handleSelect(employee.id)}
            >
              <CardContent className="flex flex-col items-center gap-2 p-4 text-center">
                {selectingId === employee.id ? (
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                ) : (
                  <User className="h-8 w-8 text-muted-foreground" />
                )}
                <span className="font-medium">
                  {employee.first_name} {employee.last_name}
                </span>
                {employee.position && <span className="text-xs text-muted-foreground">{employee.position}</span>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
