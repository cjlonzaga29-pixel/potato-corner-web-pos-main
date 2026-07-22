import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { BranchResponse } from '@potato-corner/shared';
import GcashQrBulkAssignPage from './page';

const { mockUseBranches, mockUseBulkAssignGcashQr, mockMutateAsync } = vi.hoisted(() => ({
  mockUseBranches: vi.fn(),
  mockUseBulkAssignGcashQr: vi.fn(),
  mockMutateAsync: vi.fn(),
}));

vi.mock('@/hooks/queries/use-branches', () => ({
  useBranches: mockUseBranches,
  useBulkAssignGcashQr: mockUseBulkAssignGcashQr,
}));

function branch(overrides: Partial<BranchResponse> = {}): BranchResponse {
  return {
    id: 'branch-1',
    name: 'Main Branch',
    code: 'PC-MNL-001',
    address: '123 Rizal St',
    city: 'Manila',
    gpsLatitude: null,
    gpsLongitude: null,
    gpsRadiusMeters: 100,
    status: 'active',
    gcashQrUrl: null,
    gcashQrKey: null,
    activeSupervisorCount: 0,
    activeStaffCount: 0,
    currentStatusLabel: 'Active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function setup(overrides: { branches?: BranchResponse[]; isLoading?: boolean; isError?: boolean } = {}) {
  mockUseBranches.mockReturnValue({
    data: { branches: overrides.branches ?? [branch()], total: (overrides.branches ?? [branch()]).length, page: 1, limit: 100 },
    isLoading: overrides.isLoading ?? false,
    isError: overrides.isError ?? false,
    refetch: vi.fn(),
  });
  mockUseBulkAssignGcashQr.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
}

function makeFile(): File {
  return new File(['fake-bytes'], 'qr.png', { type: 'image/png' });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GcashQrBulkAssignPage', () => {
  it('renders a loading skeleton initially', () => {
    setup({ isLoading: true });

    const { container } = render(<GcashQrBulkAssignPage />);

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders the branch list when loaded', () => {
    setup({ branches: [branch({ id: 'branch-1', name: 'Main Branch' }), branch({ id: 'branch-2', name: 'North Branch' })] });

    render(<GcashQrBulkAssignPage />);

    expect(screen.getByText(/Main Branch/)).toBeInTheDocument();
    expect(screen.getByText(/North Branch/)).toBeInTheDocument();
  });

  it('disables the assign button when no file is selected', () => {
    setup();

    render(<GcashQrBulkAssignPage />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Main Branch/ }));

    expect(screen.getByRole('button', { name: /Assign to/ })).toBeDisabled();
  });

  it('disables the assign button when no branches are selected', () => {
    setup();

    render(<GcashQrBulkAssignPage />);
    const fileInput = screen.getByLabelText('Upload GCash QR image').querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeFile()] } });

    expect(screen.getByRole('button', { name: /Assign to 0 branch/ })).toBeDisabled();
  });

  it('enables the assign button when a file and at least one branch are selected', () => {
    setup();

    render(<GcashQrBulkAssignPage />);
    const fileInput = screen.getByLabelText('Upload GCash QR image').querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeFile()] } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Main Branch/ }));

    expect(screen.getByRole('button', { name: /Assign to 1 branch/ })).not.toBeDisabled();
  });

  it('renders the result panel after a successful assignment', async () => {
    setup();
    mockMutateAsync.mockResolvedValue({
      successful: [{ branchId: 'branch-1', gcashQrUrl: 'https://cdn.test/qr.webp' }],
      failed: [],
    });

    render(<GcashQrBulkAssignPage />);
    const fileInput = screen.getByLabelText('Upload GCash QR image').querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeFile()] } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Main Branch/ }));
    fireEvent.click(screen.getByRole('button', { name: /Assign to 1 branch/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('Assigned successfully (1)')).toBeInTheDocument();
  });
});
