'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { AttendanceResponse } from '@potato-corner/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/shared/status-badge';
import { formatDateTime } from '@/lib/utils';
import { useManualOverride } from '@/hooks/queries/use-attendance';

const MIN_REASON_LENGTH = 10;

interface AttendanceOverrideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: AttendanceResponse;
}

/** Converts an ISO timestamp to the value a `datetime-local` input expects (no trailing Z, minute precision). */
function toDatetimeLocalValue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function AttendanceOverrideDialog({ open, onOpenChange, record }: AttendanceOverrideDialogProps) {
  const manualOverride = useManualOverride();
  const [reason, setReason] = useState('');
  const [clockIn, setClockIn] = useState(() => toDatetimeLocalValue(record.clock_in_server_time));
  const [clockOut, setClockOut] = useState(() => toDatetimeLocalValue(record.clock_out_server_time));
  const reasonTooShort = reason.trim().length < MIN_REASON_LENGTH;

  function handleOpenChange(next: boolean) {
    if (!next) {
      setReason('');
      setClockIn(toDatetimeLocalValue(record.clock_in_server_time));
      setClockOut(toDatetimeLocalValue(record.clock_out_server_time));
    }
    onOpenChange(next);
  }

  async function handleSubmit() {
    if (reasonTooShort) return;
    await manualOverride.mutateAsync({
      original_record_id: record.id,
      correction_reason: reason.trim(),
      clock_in_server_time: clockIn ? new Date(clockIn).toISOString() : undefined,
      clock_out_server_time: clockOut ? new Date(clockOut).toISOString() : null,
    });
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Correct Attendance Record
            <StatusBadge status={record.status} type="attendance" />
          </DialogTitle>
          <DialogDescription>
            Original clock-in {formatDateTime(record.clock_in_server_time)}
            {record.clock_out_server_time ? ` — clock-out ${formatDateTime(record.clock_out_server_time)}` : ' — still clocked in'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="override-clock-in">Corrected clock-in</Label>
              <Input id="override-clock-in" type="datetime-local" value={clockIn} onChange={(e) => setClockIn(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="override-clock-out">Corrected clock-out</Label>
              <Input id="override-clock-out" type="datetime-local" value={clockOut} onChange={(e) => setClockOut(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="override-reason">
              Reason <span className="italic text-muted-foreground">(required, min {MIN_REASON_LENGTH} characters)</span>
            </Label>
            <Textarea
              id="override-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Explain why this record is being corrected"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {reason.trim().length}/{MIN_REASON_LENGTH}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" disabled={manualOverride.isPending || reasonTooShort} onClick={() => void handleSubmit()}>
            {manualOverride.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit Correction
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
