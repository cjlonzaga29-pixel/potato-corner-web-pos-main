import { describe, it, expect, beforeEach } from 'vitest';
import { useSelectedBranchStore } from './selected-branch.store';

beforeEach(() => {
  localStorage.clear();
  useSelectedBranchStore.setState({ selectedBranchId: 'all' });
});

describe('useSelectedBranchStore', () => {
  it('defaults to "all"', () => {
    expect(useSelectedBranchStore.getState().selectedBranchId).toBe('all');
  });

  it('setSelectedBranch updates the state', () => {
    useSelectedBranchStore.getState().setSelectedBranch('branch-1');
    expect(useSelectedBranchStore.getState().selectedBranchId).toBe('branch-1');
  });

  it('persists the selection to localStorage under the potato-corner:selected-branch key', () => {
    useSelectedBranchStore.getState().setSelectedBranch('branch-2');
    const raw = localStorage.getItem('potato-corner:selected-branch');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).state.selectedBranchId).toBe('branch-2');
  });

  it('survives a store re-init by rehydrating from localStorage', () => {
    useSelectedBranchStore.getState().setSelectedBranch('branch-3');
    useSelectedBranchStore.persist.rehydrate();
    expect(useSelectedBranchStore.getState().selectedBranchId).toBe('branch-3');
  });
});
