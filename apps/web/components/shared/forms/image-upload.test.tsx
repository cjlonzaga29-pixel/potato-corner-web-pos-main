import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

function captureFallbackInput(): HTMLInputElement {
  const input = document.querySelectorAll('input[type="file"]')[1] as HTMLInputElement;
  if (!input) throw new Error('capture fallback file input not found');
  return input;
}

let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getUserMedia = vi.fn();
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
    writable: true,
  });
  HTMLVideoElement.prototype.play = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // @ts-expect-error -- test-only cleanup of the per-test mediaDevices stub
  delete navigator.mediaDevices;
});

describe('ImageUpload — camera available', () => {
  it('starts a live preview and captures a photo via getUserMedia', async () => {
    const tracks = [{ stop: vi.fn() }];
    getUserMedia.mockResolvedValue({ getTracks: () => tracks });
    const onImageSelected = vi.fn().mockResolvedValue(undefined);

    render(<ImageUpload label="Payment Proof" required onImageSelected={onImageSelected} />);
    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'environment' } }));
    await waitFor(() => expect(screen.getByText('Live capture')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Confirm/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(onImageSelected).toHaveBeenCalledWith(expect.any(File), 'live_capture'));
  });
});

describe('ImageUpload — camera denied', () => {
  it('falls back to the capture-fallback picker and labels the failure as permission denied', async () => {
    const denied = new DOMException('denied', 'NotAllowedError');
    getUserMedia.mockRejectedValue(denied);
    const clickSpy = vi.fn();

    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);
    captureFallbackInput().addEventListener('click', clickSpy);
    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));

    await waitFor(() => expect(screen.getByText(/permission denied/i)).toBeInTheDocument());
    expect(clickSpy).toHaveBeenCalled();
  });
});

describe('ImageUpload — camera unsupported', () => {
  it('skips getUserMedia entirely and goes straight to the fallback picker when unsupported', async () => {
    // @ts-expect-error -- simulate a browser with no mediaDevices at all
    delete navigator.mediaDevices;
    const clickSpy = vi.fn();

    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);
    captureFallbackInput().addEventListener('click', clickSpy);
    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));

    await waitFor(() => expect(screen.getByText(/not supported/i)).toBeInTheDocument());
    expect(clickSpy).toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
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
