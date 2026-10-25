import { describe, it, expect, beforeEach } from 'vitest';
import { useProductBuilderStore } from './product-builder.store';

/** POS-PERF-P37 — the pre-creation branch selection survives step navigation and reloads, and never leaks into a different draft. */
describe('useProductBuilderStore draftBranchIds', () => {
  beforeEach(() => {
    useProductBuilderStore.getState().reset();
  });

  it('keeps the selection across step changes and persists it to localStorage', () => {
    const store = useProductBuilderStore.getState();
    store.setDraftBranchIds(['branch-a', 'branch-b']);
    store.setStep('sizes');
    store.setStep('details');

    expect(useProductBuilderStore.getState().draftBranchIds).toEqual(['branch-a', 'branch-b']);
    const persisted = JSON.parse(localStorage.getItem('potato-corner:product-builder-draft') ?? '{}') as { state?: { draftBranchIds?: string[] } };
    expect(persisted.state?.draftBranchIds).toEqual(['branch-a', 'branch-b']);
  });

  it('clears the selection when starting a new product or entering Edit Product', () => {
    useProductBuilderStore.getState().setDraftBranchIds(['branch-a']);
    useProductBuilderStore.getState().reset();
    expect(useProductBuilderStore.getState().draftBranchIds).toEqual([]);

    useProductBuilderStore.getState().setDraftBranchIds(['branch-a']);
    useProductBuilderStore.getState().loadExisting('product-1');
    expect(useProductBuilderStore.getState().draftBranchIds).toEqual([]);
  });
});
