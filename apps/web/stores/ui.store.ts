import { create } from 'zustand';

interface UiState {
  activeModal: string | null;
  isSidebarOpen: boolean;
  openModal: (modal: string) => void;
  closeModal: () => void;
  toggleSidebar: () => void;
}

/** Ephemeral UI state — which modal/drawer is open, sidebar collapsed state. */
export const useUiStore = create<UiState>((set) => ({
  activeModal: null,
  isSidebarOpen: true,
  openModal: (modal) => set({ activeModal: modal }),
  closeModal: () => set({ activeModal: null }),
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
}));
