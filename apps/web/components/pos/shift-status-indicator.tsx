'use client';

import { Circle } from 'lucide-react';
import { useShiftStore } from '@/stores/shift.store';

export function ShiftStatusIndicator() {
  const isShiftOpen = useShiftStore((state) => state.isShiftOpen);

  return (
    <div className="flex items-center gap-1.5 text-xs font-medium">
      <Circle className={`h-2 w-2 ${isShiftOpen ? 'fill-success text-success' : 'fill-muted-foreground text-muted-foreground'}`} />
      {isShiftOpen ? 'Shift open' : 'No active shift'}
    </div>
  );
}
