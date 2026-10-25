import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export const BUILDER_STEPS = ['details', 'sizes', 'ingredients', 'choices', 'review'] as const;
export type BuilderStep = (typeof BUILDER_STEPS)[number];

interface ProductBuilderState {
  /** Null until Step 1 (Details) successfully creates the Product; every later step edits this same product. */
  productId: string | null;
  step: BuilderStep;
  /**
   * POS-PERF-P37 — Step 1's "Available at branches" checkboxes before the
   * Product exists. Once it is created, the server's branch_availability rows
   * are the selection of record and this is no longer read.
   */
  draftBranchIds: string[];
  setProductId: (id: string) => void;
  setStep: (step: BuilderStep) => void;
  setDraftBranchIds: (branchIds: string[]) => void;
  /** Starts a brand-new draft, discarding any in-progress one — distinct from resuming an existing product (see loadExisting). */
  reset: () => void;
  /** Resumes the builder against an already-existing product (Edit Product entry point). */
  loadExisting: (productId: string) => void;
}

/**
 * POS-PERF-P36 — browser-only wizard progress for the Simple Product
 * Builder (CLAUDE.md's state-separation rule: UI/navigation state here,
 * server data stays in TanStack Query). Deliberately minimal: only
 * `productId` + `step` (+ POS-PERF-P37's pre-creation `draftBranchIds`) are
 * persisted. Every substantive field the builder
 * collects (variants, recipe components, option/flavor assignments) is
 * written to the server the moment its own step's form submits — not
 * buffered client-side until a final "save" — so a refresh never loses
 * already-entered variant/recipe/choice data, only (at most) a half-typed
 * Step 1 form before that first Product row exists. Only one draft is
 * tracked at a time by design (not a draft list) — starting a new draft
 * replaces the previous one via reset().
 */
export const useProductBuilderStore = create<ProductBuilderState>()(
  persist(
    (set) => ({
      productId: null,
      step: 'details',
      draftBranchIds: [],
      setProductId: (id) => set({ productId: id }),
      setStep: (step) => set({ step }),
      setDraftBranchIds: (branchIds) => set({ draftBranchIds: branchIds }),
      reset: () => set({ productId: null, step: 'details', draftBranchIds: [] }),
      loadExisting: (productId) => set({ productId, step: 'details', draftBranchIds: [] }),
    }),
    {
      name: 'potato-corner:product-builder-draft',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
