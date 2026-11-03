import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { CreateExtraSupplyIssueInput } from '@potato-corner/shared';

export interface PendingExtraSupplyIssue {
  operationId: string;
  /** Frozen before the first attempt, so every retry sends exactly what was confirmed. */
  payload: CreateExtraSupplyIssueInput;
  /** How many times it was sent. Past the first, a refusal no longer proves the first attempt failed. */
  attempts: number;
}

export interface ExtraSupplyDraft {
  /** Card id -> quantity. Versions and prices are read from the live card at review, never stored. */
  quantities: Record<string, number>;
  kind: 'free' | 'paid' | null;
  reason: string;
  orderReference: string;
  paymentMethod: 'cash' | 'gcash' | 'maya' | 'other';
  cashTendered: string;
  paymentReference: string;
  proof: { key: string; type: 'live_capture' | 'gallery_upload' } | null;
  pending: PendingExtraSupplyIssue | null;
}

export const EMPTY_EXTRA_SUPPLY_DRAFT: ExtraSupplyDraft = {
  quantities: {},
  kind: null,
  reason: '',
  orderReference: '',
  paymentMethod: 'cash',
  cashTendered: '',
  paymentReference: '',
  proof: null,
  pending: null,
};

export function extraSupplyDraftKey(branchId: string, cashierId: string): string {
  return `${branchId}:${cashierId}`;
}

interface ExtraSupplyDraftState {
  drafts: Record<string, ExtraSupplyDraft>;
  update: (key: string, patch: Partial<ExtraSupplyDraft>) => void;
  clear: (key: string) => void;
}

/**
 * POS-PERF-P61 — the terminal's Extra Supplies draft, one per branch and cashier, so a
 * cashier switch can't hand over another cashier's selection or payment, and it's
 * still there when they return. Apart from the product cart on purpose. localStorage
 * rather than sessionStorage: an operation whose outcome isn't known must survive a
 * closed tab, because only its original id can resolve it.
 */
export const useExtraSupplyDraftStore = create<ExtraSupplyDraftState>()(
  persist(
    (set) => ({
      drafts: {},
      update: (key, patch) => set((state) => ({ drafts: { ...state.drafts, [key]: { ...EMPTY_EXTRA_SUPPLY_DRAFT, ...state.drafts[key], ...patch } } })),
      clear: (key) =>
        set((state) => {
          const { [key]: _removed, ...rest } = state.drafts;
          return { drafts: rest };
        }),
    }),
    { name: 'potato-corner-extra-supply-drafts', storage: createJSONStorage(() => localStorage), partialize: (state) => ({ drafts: state.drafts }) },
  ),
);
