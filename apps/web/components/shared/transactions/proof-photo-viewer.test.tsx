import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/transaction-export-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/transaction-export-client')>();
  return { ...actual, downloadProofPhoto: vi.fn() };
});

const { downloadProofPhoto, DownloadError } = await import('@/lib/transaction-export-client');
const { ProofPhotoViewer } = await import('./proof-photo-viewer');

const baseProps = {
  kind: 'payment' as const,
  transactionId: 'txn-1',
  url: 'https://storage.local/object/sign/payment-proofs/a.png?token=t',
  captureType: 'gallery_upload',
  uploadedAt: '2026-10-27T13:05:00.000Z',
  isLoading: false,
  isError: false,
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

// POS-PERF-P40R — permanent absence vs temporary failure.
describe('ProofPhotoViewer', () => {
  it('shows "Photo unavailable" with an explanation and no retry when the file is confirmed missing', () => {
    render(<ProofPhotoViewer {...baseProps} url={undefined} isError isMissing onReload={vi.fn()} />);

    expect(screen.getByText('Photo unavailable')).toBeInTheDocument();
    expect(screen.getByText(/no longer in storage/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Try again/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download photo/ })).not.toBeInTheDocument();
  });

  it('keeps "Try again" for a temporary failure and never calls it missing', () => {
    const onReload = vi.fn();
    render(<ProofPhotoViewer {...baseProps} url={undefined} isError onReload={onReload} />);

    expect(screen.queryByText('Photo unavailable')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('offers "Reload photo" when a signed link has expired (the image fails to load)', () => {
    const onReload = vi.fn();
    render(<ProofPhotoViewer {...baseProps} onReload={onReload} />);

    fireEvent.error(screen.getByRole('img', { name: 'Payment proof' }));
    fireEvent.click(screen.getByRole('button', { name: /Reload photo/ }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Photo unavailable')).not.toBeInTheDocument();
  });

  it('switches to "Photo unavailable" when Download finds the file gone', async () => {
    vi.mocked(downloadProofPhoto).mockRejectedValue(new DownloadError('This photo is no longer in storage.', 'PROOF_FILE_MISSING'));
    render(<ProofPhotoViewer {...baseProps} onReload={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Download photo/ }));
    expect(await screen.findByText('Photo unavailable')).toBeInTheDocument();
  });

  it('keeps Download retryable after a temporary failure', async () => {
    vi.mocked(downloadProofPhoto).mockRejectedValue(new DownloadError('Could not generate a download link for this photo', 'PAYMENT_PROOF_URL_FAILED'));
    render(<ProofPhotoViewer {...baseProps} onReload={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Download photo/ }));
    expect(await screen.findByText(/Could not generate a download link for this photo Try again\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Download photo/ })).toBeEnabled());
    expect(screen.queryByText('Photo unavailable')).not.toBeInTheDocument();
  });
});
