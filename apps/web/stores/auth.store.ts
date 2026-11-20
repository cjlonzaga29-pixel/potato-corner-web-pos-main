import { create } from 'zustand';
import { ROLES, type Role } from '@potato-corner/shared';

export interface AuthUser {
  id: string;
  role: Role;
  /** Nullable — `staff` (Employees) have no email (Branch Employee Authorization). */
  email: string | null;
  firstName: string;
  lastName: string;
  branchIds: string[];
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /**
   * POS-PERF-P62 — goes up whenever an identity is left behind: a sign-out, or a
   * different account signing in. Not when a session is restored after a
   * reload, nor when the same user's token is refreshed. Providers clears the
   * query cache on a change, and api-client.ts drops any response that
   * started under an earlier value.
   */
  identityEpoch: number;
  setAuth: (user: AuthUser, accessToken: string) => void;
  clearAuth: () => void;
  setLoading: (isLoading: boolean) => void;
  /** Self-service Profile name edit — patches the cached identity in place so every subscriber (sidebar, header, POS) re-renders with the new name immediately, without a fresh login/refresh. */
  updateName: (firstName: string, lastName: string) => void;
  hasRole: (role: Role) => boolean;
  /** True for super_admin regardless of branchId, otherwise true only if branchId is in the user's branch_ids. */
  hasBranchAccess: (branchId: string) => boolean;
  isAdmin: () => boolean;
  isSupervisor: () => boolean;
  isStaff: () => boolean;
}

const initialState = {
  user: null,
  accessToken: null,
  isAuthenticated: false,
  isLoading: true,
};

/**
 * Identity cache plus the in-memory access token (never persisted to
 * localStorage or cookies — see Architecture doc §5.1). The refresh token
 * lives in an HttpOnly cookie and is never touched here. Reset completely
 * on logout, not just cleared field-by-field.
 */
export const useAuthStore = create<AuthState>((set, get) => ({
  ...initialState,
  identityEpoch: 0,
  setAuth: (user, accessToken) =>
    set((state) => ({
      user,
      accessToken,
      isAuthenticated: true,
      isLoading: false,
      identityEpoch: state.user && state.user.id !== user.id ? state.identityEpoch + 1 : state.identityEpoch,
    })),
  clearAuth: () =>
    set((state) => ({
      ...initialState,
      isLoading: false,
      identityEpoch: state.user || state.accessToken ? state.identityEpoch + 1 : state.identityEpoch,
    })),
  setLoading: (isLoading) => set({ isLoading }),
  updateName: (firstName, lastName) =>
    set((state) => (state.user ? { user: { ...state.user, firstName, lastName } } : {})),
  hasRole: (role) => get().user?.role === role,
  hasBranchAccess: (branchId) => {
    const { user } = get();
    if (!user) return false;
    if (user.role === ROLES.SUPER_ADMIN) return true;
    return user.branchIds.includes(branchId);
  },
  isAdmin: () => get().user?.role === ROLES.SUPER_ADMIN,
  isSupervisor: () => get().user?.role === ROLES.SUPERVISOR,
  isStaff: () => get().user?.role === ROLES.STAFF,
}));
