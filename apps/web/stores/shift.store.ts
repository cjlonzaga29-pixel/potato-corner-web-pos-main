import { create } from 'zustand';
import type { ShiftResponse } from '@potato-corner/shared';

interface ShiftState {
  shiftId: string | null;
  isShiftOpen: boolean;
  currentShift: ShiftResponse | null;
  openShift: (shiftId: string) => void;
  closeShift: () => void;
  setCurrentShift: (shift: ShiftResponse | null) => void;
  clearShift: () => void;
}

/** Whether a shift is open, and which one — browser-only, not server data (the actual shift record lives in TanStack Query's cache via useCurrentShift). */
export const useShiftStore = create<ShiftState>((set) => ({
  shiftId: null,
  isShiftOpen: false,
  currentShift: null,
  openShift: (shiftId) => set({ shiftId, isShiftOpen: true }),
  closeShift: () => set({ shiftId: null, isShiftOpen: false, currentShift: null }),
  setCurrentShift: (shift) => set({ currentShift: shift, shiftId: shift?.id ?? null, isShiftOpen: shift?.status === 'active' }),
  clearShift: () => set({ currentShift: null, shiftId: null, isShiftOpen: false }),
}));
