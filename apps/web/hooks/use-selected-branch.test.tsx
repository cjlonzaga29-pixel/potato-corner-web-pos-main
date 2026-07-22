import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { ROLES } from '@potato-corner/shared';
import { useSelectedBranch } from './use-selected-branch';
import { useSelectedBranchStore } from '@/stores/selected-branch.store';

const { mockReplace, mockUseAuth, mockUseBranches, mockSearchParams } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockUseAuth: vi.fn(),
  mockUseBranches: vi.fn(),
  mockSearchParams: { value: new URLSearchParams() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => '/admin/dashboard',
  useSearchParams: () => mockSearchParams.value,
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: mockUseAuth,
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
}));

function branch(id: string, name: string) {
  return {
    id,
    name,
    code: `PC-${id}`,
    address: '123 St',
    city: 'Manila',
    gpsLatitude: null,
    gpsLongitude: null,
    gpsRadiusMeters: 100,
    status: 'active' as const,
    gcashQrUrl: null,
    gcashQrKey: null,
    activeSupervisorCount: 0,
    activeStaffCount: 0,
    currentStatusLabel: 'Active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const ALL_BRANCHES = [branch('branch-1', 'Manila'), branch('branch-2', 'Cebu'), branch('branch-3', 'Davao')];

beforeEach(() => {
  useSelectedBranchStore.setState({ selectedBranchId: 'all' });
  mockSearchParams.value = new URLSearchParams();
  mockUseBranches.mockReturnValue({ data: { branches: ALL_BRANCHES, total: 3, page: 1, limit: 100 } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useSelectedBranch', () => {
  it('overrides the store from the branch_id URL param on mount', () => {
    mockSearchParams.value = new URLSearchParams('branch_id=branch-2');
    mockUseAuth.mockReturnValue({ user: { role: ROLES.SUPER_ADMIN, branchIds: [] } });

    const { result } = renderHook(() => useSelectedBranch());

    expect(result.current.selectedBranchId).toBe('branch-2');
  });

  it('super_admin sees all active branches and the "All Branches" label', () => {
    mockUseAuth.mockReturnValue({ user: { role: ROLES.SUPER_ADMIN, branchIds: [] } });

    const { result } = renderHook(() => useSelectedBranch());

    expect(result.current.availableBranches).toHaveLength(3);
    expect(result.current.allLabel).toBe('All Branches');
    expect(result.current.isSingleBranchUser).toBe(false);
  });

  it('supervisor only sees their assigned branches and the "All my branches" label', () => {
    mockUseAuth.mockReturnValue({ user: { role: ROLES.SUPERVISOR, branchIds: ['branch-1', 'branch-2'] } });

    const { result } = renderHook(() => useSelectedBranch());

    expect(result.current.availableBranches.map((b) => b.id)).toEqual(['branch-1', 'branch-2']);
    expect(result.current.allLabel).toBe('All my branches');
  });

  it('detects a single-branch supervisor as isSingleBranchUser', () => {
    mockUseAuth.mockReturnValue({ user: { role: ROLES.SUPERVISOR, branchIds: ['branch-1'] } });

    const { result } = renderHook(() => useSelectedBranch());

    expect(result.current.isSingleBranchUser).toBe(true);
  });

  it('a super_admin with no branch_ids is never treated as a single-branch user', () => {
    mockUseAuth.mockReturnValue({ user: { role: ROLES.SUPER_ADMIN, branchIds: [] } });

    const { result } = renderHook(() => useSelectedBranch());

    expect(result.current.isSingleBranchUser).toBe(false);
  });
});
