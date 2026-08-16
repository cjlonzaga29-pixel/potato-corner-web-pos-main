import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { InventoryCostCorrectionsView } from './inventory-cost-corrections-view';

const { mockUseBranchStore, mockUseInventoryCostCorrections } = vi.hoisted(() => ({
  mockUseBranchStore: vi.fn(),
  mockUseInventoryCostCorrections: vi.fn(),
}));

vi.mock('@/stores/branch.store', () => ({
  useBranchStore: mockUseBranchStore,
}));

vi.mock('@/hooks/queries/use-universal-inventory', () => ({
  useInventoryCostCorrections: mockUseInventoryCostCorrections,
}));

const BRANCH_ID = '123e4567-e89b-12d3-a456-426614174000';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InventoryCostCorrectionsView — branchId prop override', () => {
  it('queries corrections for the prop branchId, ignoring the store, when branchId is passed', () => {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
      selector({ activeBranchId: 'store-branch-id' }),
    );
    mockUseInventoryCostCorrections.mockReturnValue({
      data: { corrections: [], total: 0, page: 1, limit: 25 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<InventoryCostCorrectionsView branchId="admin-picked-branch-id" />);

    expect(mockUseInventoryCostCorrections).toHaveBeenCalledWith('admin-picked-branch-id', expect.anything());
  });

  it("falls back to the store's active branch when branchId is omitted (unchanged default behavior)", () => {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) =>
      selector({ activeBranchId: BRANCH_ID }),
    );
    mockUseInventoryCostCorrections.mockReturnValue({
      data: { corrections: [], total: 0, page: 1, limit: 25 },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<InventoryCostCorrectionsView />);

    expect(mockUseInventoryCostCorrections).toHaveBeenCalledWith(BRANCH_ID, expect.anything());
  });

  it('shows the "select a branch" prompt instead of the table when no branch is resolved', () => {
    mockUseBranchStore.mockImplementation((selector: (s: { activeBranchId: string | null }) => unknown) => selector({ activeBranchId: null }));
    mockUseInventoryCostCorrections.mockReturnValue({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() });

    render(<InventoryCostCorrectionsView />);

    expect(screen.getByText('Select an active branch to view its cost correction history.')).toBeInTheDocument();
  });
});
