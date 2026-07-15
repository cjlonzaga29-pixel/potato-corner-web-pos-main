import { describe, it, expect, beforeEach } from 'vitest';
import { ROLES } from '@potato-corner/shared';
import { useAuthStore, type AuthUser } from './auth.store';

const STAFF_USER: AuthUser = {
  id: 'u1',
  role: ROLES.STAFF,
  email: 'staff@potatocorner.test',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  branchIds: ['branch-1'],
};

const ADMIN_USER: AuthUser = {
  id: 'u2',
  role: ROLES.SUPER_ADMIN,
  email: 'admin@potatocorner.test',
  firstName: 'Ana',
  lastName: 'Reyes',
  branchIds: [],
};

beforeEach(() => {
  useAuthStore.getState().clearAuth();
});

describe('useAuthStore', () => {
  it('starts unauthenticated with no user', () => {
    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.isAuthenticated).toBe(false);
  });

  it('setAuth stores the user and access token and flips isAuthenticated', () => {
    useAuthStore.getState().setAuth(STAFF_USER, 'token-123');
    const state = useAuthStore.getState();
    expect(state.user).toEqual(STAFF_USER);
    expect(state.accessToken).toBe('token-123');
    expect(state.isAuthenticated).toBe(true);
    expect(state.isLoading).toBe(false);
  });

  it('clearAuth resets to the initial state', () => {
    useAuthStore.getState().setAuth(STAFF_USER, 'token-123');
    useAuthStore.getState().clearAuth();
    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.accessToken).toBeNull();
    expect(state.isAuthenticated).toBe(false);
  });

  it('hasBranchAccess is true for super_admin regardless of branchId', () => {
    useAuthStore.getState().setAuth(ADMIN_USER, 'token');
    expect(useAuthStore.getState().hasBranchAccess('any-branch')).toBe(true);
  });

  it('hasBranchAccess only allows branches in the user branch_ids for non-admins', () => {
    useAuthStore.getState().setAuth(STAFF_USER, 'token');
    expect(useAuthStore.getState().hasBranchAccess('branch-1')).toBe(true);
    expect(useAuthStore.getState().hasBranchAccess('branch-2')).toBe(false);
  });

  it('role helpers reflect the current user role', () => {
    useAuthStore.getState().setAuth(STAFF_USER, 'token');
    expect(useAuthStore.getState().isStaff()).toBe(true);
    expect(useAuthStore.getState().isAdmin()).toBe(false);
    expect(useAuthStore.getState().isSupervisor()).toBe(false);
  });
});
