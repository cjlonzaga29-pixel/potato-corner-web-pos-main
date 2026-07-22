import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface SelectedBranchState {
  /** 'all' or a branch UUID — the dashboard's branch-scoping selection. */
  selectedBranchId: string;
  setSelectedBranch: (id: string) => void;
}

export const useSelectedBranchStore = create<SelectedBranchState>()(
  persist(
    (set) => ({
      selectedBranchId: 'all',
      setSelectedBranch: (id) => set({ selectedBranchId: id }),
    }),
    {
      name: 'potato-corner:selected-branch',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
