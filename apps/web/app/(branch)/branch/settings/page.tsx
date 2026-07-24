'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shared/feedback/empty-state';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { useAuth } from '@/hooks/use-auth';
import { useBranch } from '@/hooks/queries/use-branches';

/**
 * Read-only branch profile — a `branch` account can view its own branch's
 * settings but has no edit capability today: PATCH /api/branches/:id and
 * the GCash QR upload endpoint are both Super Admin-only (branches.router.ts's
 * adminOnly guards). Changing that is an RBAC decision outside this page's
 * scope, not something to silently work around here.
 */
export default function BranchSettingsPage() {
  const { user } = useAuth();
  const branchId = user?.branchIds[0];
  const { data: branch, isLoading, isError, refetch } = useBranch(branchId);

  if (!branchId) {
    return <EmptyState title="No branch assigned" description="Contact your supervisor to get staffed to a branch." />;
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (isError || !branch) {
    return <ErrorState title="Failed to load branch settings" retry={() => void refetch()} />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Branch Settings</h1>
        <p className="text-sm text-muted-foreground">Your branch&apos;s profile. Contact Super Admin to change any of this.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Branch Profile</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-muted-foreground">Name</p>
            <p className="font-medium">{branch.name}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Code</p>
            <p className="font-medium">{branch.code}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Address</p>
            <p className="font-medium">{branch.address}</p>
          </div>
          <div>
            <p className="text-muted-foreground">City</p>
            <p className="font-medium">{branch.city}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Status</p>
            <Badge variant={branch.status === 'active' ? 'active' : 'critical'}>{branch.currentStatusLabel}</Badge>
          </div>
          <div>
            <p className="text-muted-foreground">GPS Clock-In Radius</p>
            <p className="font-medium">{branch.gpsRadiusMeters ? `${branch.gpsRadiusMeters} m` : 'Not configured'}</p>
          </div>
        </CardContent>
      </Card>

      {branch.gcashQrUrl && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">GCash QR</CardTitle>
          </CardHeader>
          <CardContent>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={branch.gcashQrUrl} alt="Branch GCash QR code" className="h-48 w-48 rounded-md border object-contain" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
