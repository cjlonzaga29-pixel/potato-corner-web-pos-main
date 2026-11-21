import { describe, it, expect, beforeEach } from 'vitest';
import type { BranchResponse } from '@potato-corner/shared';
import { useAuthStore, type AuthUser } from './auth.store';
import { useBranchStore } from './branch.store';

const SUPERVISOR_A: AuthUser = { id: 'sa', role: 'supervisor', email: 'a@x.test', firstName: '', lastName: '', branchIds: ['b1', 'b2'] };
const SUPERVISOR_B: AuthUser = { id: 'sb', role: 'supervisor', email: 'b@x.test', firstName: '', lastName: '', branchIds: ['b3'] };

beforeEach(() => {
  useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false, isLoading: true, sessionStatus: 'restoring', identityEpoch: 0 });
  useBranchStore.setState({ activeBranchId: null, activeBranch: null, restoredBranchId: null });
});

describe('POS-PERF-P62 — the reloaded branch is a hint until the session allows it', () => {
  it('stays unset while the session is restoring, then applies once the token grants the branch', () => {
    useBranchStore.setState({ restoredBranchId: 'b2' });
    expect(useBranchStore.getState().activeBranchId).toBeNull();

    useAuthStore.getState().setAuth(SUPERVISOR_A, 'token-a');

    expect(useBranchStore.getState().activeBranchId).toBe('b2');
  });

  it('never applies a branch the restored token does not grant', () => {
    useBranchStore.setState({ restoredBranchId: 'b9' });

    useAuthStore.getState().setAuth(SUPERVISOR_A, 'token-a');

    expect(useBranchStore.getState().activeBranchId).toBeNull();
  });

  it('a transient restore failure applies nothing', () => {
    useBranchStore.setState({ restoredBranchId: 'b1' });

    useAuthStore.getState().markSessionUnconfirmed();

    expect(useBranchStore.getState().activeBranchId).toBeNull();
  });

  it('signing out forgets the branch, so the next account never starts on it', () => {
    useAuthStore.getState().setAuth(SUPERVISOR_A, 'token-a');
    useBranchStore.getState().setActiveBranch({ id: 'b1' } as BranchResponse);

    useAuthStore.getState().clearAuth();
    useAuthStore.getState().setAuth(SUPERVISOR_B, 'token-b');

    expect(useBranchStore.getState()).toMatchObject({ activeBranchId: null, activeBranch: null, restoredBranchId: null });
  });

  it('keeps the stored shape: what is persisted is still { activeBranchId }', () => {
    useAuthStore.getState().setAuth(SUPERVISOR_A, 'token-a');
    useBranchStore.getState().setActiveBranch({ id: 'b2' } as BranchResponse);

    expect(JSON.parse(sessionStorage.getItem('potato-corner-active-branch') ?? '{}').state).toEqual({ activeBranchId: 'b2' });
  });
});
