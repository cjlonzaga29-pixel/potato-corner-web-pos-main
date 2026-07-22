import { create } from 'zustand';
import { ROLES, type Role } from '@potato-corner/shared';

export interface AuthUser {
  id: string;
  role: Role;
  email: string;
  firstName: string;
  lastName: string;
  branchIds: string[];
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  setAuth: (user: AuthUser, accessToken: string) => void;
  setAccessToken: (accessToken: string) => void;
  clearAuth: () => void;
  setLoading: (isLoading: boolean) => void;
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
  setAuth: (user, accessToken) => set({ user, accessToken, isAuthenticated: true, isLoading: false }),
  setAccessToken: (accessToken) => set({ accessToken }),
  clearAuth: () => set({ ...initialState, isLoading: false }),
  setLoading: (isLoading) => set({ isLoading }),
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
