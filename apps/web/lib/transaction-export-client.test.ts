import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn(), fetchAuthenticated: vi.fn() }));

const { apiClient } = await import('@/lib/api-client');
const { downloadProofPhoto, DownloadError } = await import('./transaction-export-client');

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('downloadProofPhoto', () => {
  it('navigates to the fresh attachment URL', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.mocked(apiClient).mockResolvedValue({
      data: { download_url: 'https://storage.local/sign/a.png?token=t&download=payment-proof-1.png', filename: 'payment-proof-1.png', expires_in_seconds: 300 },
      error: null,
      meta: null,
    });

    await expect(downloadProofPhoto('payment', 'txn-1')).resolves.toBe('payment-proof-1.png');
    expect(apiClient).toHaveBeenCalledWith('/api/transactions/txn-1/payment-proof?download=1');
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it('carries the API code so the viewer can tell a missing file from a temporary failure', async () => {
    vi.mocked(apiClient).mockResolvedValue({ data: null, error: { code: 'PROOF_FILE_MISSING', message: 'gone' }, meta: null });

    const error = await downloadProofPhoto('discount', 'txn-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect(error).toMatchObject({ code: 'PROOF_FILE_MISSING', message: 'gone' });
  });

  // POS-PERF-P40R — new web, old API: ?download=1 is ignored and the inline shape comes back.
  it('refuses to navigate when an older API answers without download_url', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.mocked(apiClient).mockResolvedValue({
      data: { payment_proof_url: 'https://storage.local/sign/a.png?token=t', payment_proof_type: 'live_capture', uploaded_at: null },
      error: null,
      meta: null,
    });

    await expect(downloadProofPhoto('payment', 'txn-1')).rejects.toThrow(/not available until the server update finishes/);
    expect(click).not.toHaveBeenCalled();
    expect(document.querySelector('a')).toBeNull();
    click.mockRestore();
  });
});
