import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ImageUpload } from './image-upload';

// jsdom implements neither createImageBitmap nor canvas 2D drawing/encoding
// — same stubs terminal/page.test.tsx uses to drive ImageUpload's
// compression pipeline in a real gallery/capture interaction.
if (typeof globalThis.createImageBitmap === 'undefined') {
  globalThis.createImageBitmap = vi.fn().mockResolvedValue({ width: 10, height: 10 }) as never;
}
HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({ drawImage: vi.fn() }) as never;
HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback) {
  callback(new Blob(['fake-image'], { type: 'image/jpeg' }));
};

function jpegFile(name = 'proof.jpg', size = 1024, type = 'image/jpeg'): File {
  return new File([new Uint8Array(size)], name, { type });
}

function galleryInput(): HTMLInputElement {
  const input = document.querySelectorAll('input[type="file"]')[0] as HTMLInputElement;
  if (!input) throw new Error('gallery file input not found');
  return input;
}

function captureInput(): HTMLInputElement {
  const input = document.querySelectorAll('input[type="file"]')[1] as HTMLInputElement;
  if (!input) throw new Error('capture file input not found');
  return input;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ImageUpload — native device capture (Task 209.56E)', () => {
  it('Take Photo clicks the native capture="environment" file input — no embedded live camera preview is ever rendered', () => {
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    const clickSpy = vi.fn();
    captureInput().addEventListener('click', clickSpy);
    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(document.querySelector('video')).toBeNull();
    expect(screen.queryByText('Live capture')).not.toBeInTheDocument();
  });

  it('the capture input carries capture="environment" so mobile/tablet browsers open the native rear-camera UI', () => {
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);
    expect(captureInput().getAttribute('capture')).toBe('environment');
    // Task 209.56E follow-up — must stay the broad image/* wildcard, not a
    // comma-separated MIME list: several Android browsers only reliably
    // route capture="environment" to the camera app (not the gallery/
    // library picker) when accept is this wildcard. validateFile() is the
    // real type gate regardless of what this attribute allows through.
    expect(captureInput().getAttribute('accept')).toBe('image/*');
  });

  it('a photo produced via the capture input previews and confirms as a live_capture', async () => {
    const onImageSelected = vi.fn().mockResolvedValue(undefined);
    render(<ImageUpload label="Payment Proof" required onImageSelected={onImageSelected} />);

    fireEvent.change(captureInput(), { target: { files: [jpegFile('camera.jpg')] } });
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());
    expect(screen.getByText('Photo captured')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(onImageSelected).toHaveBeenCalledWith(expect.any(File), 'live_capture'));
  });

  it('caps the pending-confirm preview via the density-aware app-pos-proof-preview-height token', async () => {
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.change(captureInput(), { target: { files: [jpegFile('camera.jpg')] } });
    const preview = await screen.findByAltText('Preview');
    expect(preview).toHaveClass('app-pos-proof-preview-height');
  });
});

describe('ImageUpload — upload image (gallery)', () => {
  it('accepts a valid gallery file, previews it, and confirms', async () => {
    const onImageSelected = vi.fn().mockResolvedValue(undefined);
    render(<ImageUpload label="Payment Proof" required onImageSelected={onImageSelected} />);

    fireEvent.change(galleryInput(), { target: { files: [jpegFile()] } });
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());
    expect(screen.getByText('Gallery upload')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(onImageSelected).toHaveBeenCalledWith(expect.any(File), 'gallery_upload'));
  });

  it('caps the pending-confirm preview via the same density-aware app-pos-proof-preview-height token', async () => {
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.change(galleryInput(), { target: { files: [jpegFile()] } });
    const preview = await screen.findByAltText('Preview');
    expect(preview).toHaveClass('app-pos-proof-preview-height');
  });
});

describe('ImageUpload — replace image', () => {
  it('Retake clears the preview and returns to the picker buttons', async () => {
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.change(galleryInput(), { target: { files: [jpegFile()] } });
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Retake/ }));
    expect(screen.queryByAltText('Preview')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Take Photo/ })).toBeInTheDocument();
  });
});

describe('ImageUpload — remove image', () => {
  it('Remove clears the pending selection without confirming it', async () => {
    const onImageSelected = vi.fn();
    render(<ImageUpload label="Payment Proof" required onImageSelected={onImageSelected} />);

    fireEvent.change(galleryInput(), { target: { files: [jpegFile()] } });
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    expect(screen.queryByAltText('Preview')).not.toBeInTheDocument();
    expect(onImageSelected).not.toHaveBeenCalled();
  });
});

describe('ImageUpload — upload validation', () => {
  it('rejects an oversized file with an inline error and no preview', () => {
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.change(galleryInput(), { target: { files: [jpegFile('big.jpg', 6 * 1024 * 1024)] } });

    expect(screen.getByText('Image must be 5MB or smaller.')).toBeInTheDocument();
    expect(screen.queryByAltText('Preview')).not.toBeInTheDocument();
  });

  it('rejects a non-image MIME type (e.g. an executable) with an inline error', () => {
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    const exe = new File([new Uint8Array(10)], 'proof.exe', { type: 'application/x-msdownload' });
    fireEvent.change(galleryInput(), { target: { files: [exe] } });

    expect(screen.getByText('Only JPEG, PNG, or WebP images are supported.')).toBeInTheDocument();
    expect(screen.queryByAltText('Preview')).not.toBeInTheDocument();
  });

  it('rejects an invalid capture-input file the same way as a gallery file', () => {
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.change(captureInput(), { target: { files: [jpegFile('big.jpg', 6 * 1024 * 1024)] } });

    expect(screen.getByText('Image must be 5MB or smaller.')).toBeInTheDocument();
    expect(screen.queryByAltText('Preview')).not.toBeInTheDocument();
  });
});

describe('ImageUpload — upload retry', () => {
  it('shows Upload Failed inline and lets the cashier retry without recapturing', async () => {
    const onImageSelected = vi.fn().mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce(undefined);
    render(<ImageUpload label="Payment Proof" required onImageSelected={onImageSelected} />);

    fireEvent.change(galleryInput(), { target: { files: [jpegFile()] } });
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(screen.getByText('Network error')).toBeInTheDocument());
    // The failed selection is preserved — no need to recapture.
    expect(screen.getByAltText('Preview')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Retry Upload/ }));
    await waitFor(() => expect(onImageSelected).toHaveBeenCalledTimes(2));
  });
});
