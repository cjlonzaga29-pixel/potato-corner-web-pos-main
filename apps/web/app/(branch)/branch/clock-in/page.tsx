'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, MapPin } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ErrorState } from '@/components/shared/feedback/error-state';
import { useAuth } from '@/hooks/use-auth';
import { useAttendanceByEmployee, useClockIn, useClockOut } from '@/hooks/queries/use-attendance';
import { getCurrentPosition, type GpsCoords } from '@/lib/geolocation';

/** Starts null so the server-rendered markup and first client render agree — same hydration guard as PosHeader's clock. */
function useNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);
  return now;
}

function formatElapsed(startedAt: string, now: Date | null): string {
  if (!now) return '--:--:--';
  const ms = now.getTime() - new Date(startedAt).getTime();
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

export default function ClockInPage() {
  const router = useRouter();
  const { user } = useAuth();
  const branchId = user?.branchIds[0];
  const now = useNow();
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [isLocating, setIsLocating] = useState(false);

  const { data: history, isLoading, isError, refetch } = useAttendanceByEmployee(user?.id, { limit: 1 });
  const clockIn = useClockIn();
  const clockOut = useClockOut();

  const latestRecord = history?.records[0] ?? null;
  const isClockedIn = latestRecord !== null && latestRecord.clock_out_server_time === null;

  async function handleClockIn() {
    if (!user || !branchId) return;
    setGpsError(null);
    setIsLocating(true);
    try {
      const coords = await getCurrentPosition();
      await clockIn.mutateAsync({
        employee_id: user.id,
        branch_id: branchId,
        gps_lat: coords.lat,
        gps_lng: coords.lng,
      });
      // Shift is now auto-managed (opened transparently on clock-in) — go
      // straight to the POS Terminal, no separate Open Shift step.
      router.push('/branch/terminal');
    } catch (error) {
      setGpsError(error instanceof Error ? error.message : 'Unable to read your location.');
    } finally {
      setIsLocating(false);
    }
  }

  async function handleClockOut() {
    if (!user || !branchId) return;
    setGpsError(null);
    setIsLocating(true);
    // GPS is optional on clock-out (clockOutSchema) — a failure here still lets the clock-out through, just without location data.
    let coords: GpsCoords | null = null;
    try {
      coords = await getCurrentPosition();
    } catch {
      coords = null;
    }
    setIsLocating(false);
    await clockOut.mutateAsync({
      employee_id: user.id,
      branch_id: branchId,
      ...(coords ? { gps_lat: coords.lat, gps_lng: coords.lng } : {}),
    });
  }

  if (!branchId) {
    return <p className="p-6 text-sm text-destructive">No branch assigned — cannot clock in.</p>;
  }

  const isBusy = isLocating || clockIn.isPending || clockOut.isPending;

  return (
    <div className="mx-auto max-w-md space-y-6 overflow-y-auto p-6">
      <div>
        <h1 className="text-2xl font-bold">Attendance</h1>
        <p className="text-sm text-muted-foreground">Clock in when you start your shift and clock out when you leave.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{isClockedIn ? 'Currently clocked in' : 'Not clocked in'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isError ? (
            <ErrorState title="Failed to load attendance status" retry={() => void refetch()} />
          ) : (
            <>
              {isLoading ? (
                <p className="text-sm text-muted-foreground">Loading status…</p>
              ) : isClockedIn && latestRecord ? (
                <div className="space-y-1 text-sm">
                  <p className="text-muted-foreground">
                    Since {new Date(latestRecord.clock_in_server_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </p>
                  <p className="font-medium tabular-nums">{formatElapsed(latestRecord.clock_in_server_time, now)}</p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Tap Clock In to start tracking your shift attendance.</p>
              )}

              {gpsError && (
                <Alert variant="destructive">
                  <MapPin className="h-4 w-4" />
                  <AlertTitle>Location error</AlertTitle>
                  <AlertDescription>{gpsError}</AlertDescription>
                </Alert>
              )}

              {isClockedIn ? (
                <Button className="w-full touch-target" variant="danger" onClick={handleClockOut} disabled={isBusy || isLoading}>
                  {isBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Clock Out
                </Button>
              ) : (
                <Button className="w-full touch-target" onClick={handleClockIn} disabled={isBusy || isLoading}>
                  {isBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Clock In
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
