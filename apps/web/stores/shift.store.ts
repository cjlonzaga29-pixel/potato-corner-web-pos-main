import { create } from 'zustand';

interface ShiftState {
  shiftId: string | null;
  isShiftOpen: boolean;
  openShift: (shiftId: string) => void;
  closeShift: () => void;
}

/** Whether a shift is open, and which one — browser-only, not server data. */
export const useShiftStore = create<ShiftState>((set) => ({
  shiftId: null,
  isShiftOpen: false,
  openShift: (shiftId) => set({ shiftId, isShiftOpen: true }),
  closeShift: () => set({ shiftId: null, isShiftOpen: false }),
}));
