import { create } from 'zustand';

interface UiState {
  activeModal: string | null;
  isSidebarOpen: boolean;
  isMobileNavOpen: boolean;
  openModal: (modal: string) => void;
  closeModal: () => void;
  toggleSidebar: () => void;
  setMobileNavOpen: (open: boolean) => void;
  toggleMobileNav: () => void;
}

/** Ephemeral UI state — which modal/drawer is open, sidebar collapsed state. */
export const useUiStore = create<UiState>((set) => ({
  activeModal: null,
  isSidebarOpen: true,
  isMobileNavOpen: false,
  openModal: (modal) => set({ activeModal: modal }),
  closeModal: () => set({ activeModal: null }),
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  setMobileNavOpen: (open) => set({ isMobileNavOpen: open }),
  toggleMobileNav: () => set((state) => ({ isMobileNavOpen: !state.isMobileNavOpen })),
}));
