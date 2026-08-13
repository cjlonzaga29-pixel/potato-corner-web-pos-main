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

/** jsdom's default userAgent has no mobile markers, so ImageUpload's isMobileOrTablet() sees it as desktop by default — these tests exercise that default and this helper opts into the mobile/tablet path explicitly. */
function setMobileUserAgent() {
  Object.defineProperty(window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36',
    configurable: true,
  });
}

function restoreDesktopUserAgent(originalUserAgent: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: originalUserAgent, configurable: true });
}

class MockMediaStreamTrack {
  stop = vi.fn();
}

class MockMediaStream {
  private tracks: MockMediaStreamTrack[];
  constructor(tracks: MockMediaStreamTrack[] = [new MockMediaStreamTrack()]) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

function mockGetUserMediaSuccess() {
  const stream = new MockMediaStream();
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  const enumerateDevices = vi.fn().mockResolvedValue([]);
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia, enumerateDevices },
    configurable: true,
  });
  if (!HTMLMediaElement.prototype.play || vi.isMockFunction(HTMLMediaElement.prototype.play) === false) {
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  }
  return { stream, getUserMedia };
}

function mockGetUserMediaFailure(name: string) {
  const error = Object.assign(new Error('denied'), { name });
  Object.defineProperty(error, 'name', { value: name });
  const getUserMedia = vi.fn().mockRejectedValue(error);
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) },
    configurable: true,
  });
  return { getUserMedia };
}

function mockGetUserMediaUnsupported() {
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
});

describe('ImageUpload — mobile/tablet native device capture (Task 209.56E)', () => {
  it('Take Photo on mobile/tablet clicks the native capture="environment" file input — no camera modal opens', () => {
    const originalUA = window.navigator.userAgent;
    setMobileUserAgent();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    const clickSpy = vi.fn();
    captureInput().addEventListener('click', clickSpy);
    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(document.querySelector('video')).toBeNull();
    restoreDesktopUserAgent(originalUA);
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

describe('ImageUpload — desktop/laptop getUserMedia camera modal (Task 209.x)', () => {
  it('Take Photo on desktop calls getUserMedia and does not click the gallery/capture file inputs', async () => {
    const { getUserMedia } = mockGetUserMediaSuccess();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    const galleryClickSpy = vi.fn();
    const captureClickSpy = vi.fn();
    galleryInput().addEventListener('click', galleryClickSpy);
    captureInput().addEventListener('click', captureClickSpy);

    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false })));
    expect(galleryClickSpy).not.toHaveBeenCalled();
    expect(captureClickSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
  });

  it('opens a dedicated camera modal with a live preview, Capture Photo, and Cancel', async () => {
    mockGetUserMediaSuccess();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Capture Photo/ })).toBeInTheDocument();
  });

  it('Capture Photo draws the video frame to a canvas, produces a File, and feeds it into the existing upload pipeline as live_capture', async () => {
    mockGetUserMediaSuccess();
    const onImageSelected = vi.fn().mockResolvedValue(undefined);
    render(<ImageUpload label="Payment Proof" required onImageSelected={onImageSelected} />);

    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));
    const captureButton = await screen.findByRole('button', { name: /Capture Photo/ });
    await waitFor(() => expect(captureButton).not.toBeDisabled());

    fireEvent.click(captureButton);
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());
    expect(screen.getByText('Photo captured')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(onImageSelected).toHaveBeenCalledWith(expect.any(File), 'live_capture'));
  });

  it('stops all MediaStream tracks after Capture Photo', async () => {
    const { stream } = mockGetUserMediaSuccess();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));
    const captureButton = await screen.findByRole('button', { name: /Capture Photo/ });
    await waitFor(() => expect(captureButton).not.toBeDisabled());
    fireEvent.click(captureButton);

    await waitFor(() => expect(stream.getTracks()[0].stop).toHaveBeenCalledTimes(1));
  });

  it('stops all MediaStream tracks after Cancel and closes the modal', async () => {
    const { stream } = mockGetUserMediaSuccess();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));
    await screen.findByRole('dialog');
    await waitFor(() => expect(stream.getTracks().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));

    expect(stream.getTracks()[0].stop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('stops all MediaStream tracks when the component unmounts with the camera open', async () => {
    const { stream } = mockGetUserMediaSuccess();
    const { unmount } = render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());

    unmount();
    expect(stream.getTracks()[0].stop).toHaveBeenCalledTimes(1);
  });

  it('re-clicking Take Photo while the camera is already open does not request a second stream', async () => {
    // Radix marks the underlying page aria-hidden while the modal is open, so the
    // second click is fired on the raw DOM node (bypassing the accessibility-tree
    // filtering screen.getByRole applies) to exercise the isCameraOpen re-entrancy
    // guard directly, the same way a fast double-tap on a touch/mouse device would.
    const { getUserMedia } = mockGetUserMediaSuccess();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);
    const takePhotoButton = screen.getByText('Take Photo').closest('button');
    if (!takePhotoButton) throw new Error('Take Photo button not found');

    fireEvent.click(takePhotoButton);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

    fireEvent.click(takePhotoButton);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('shows a blocked-permission message and does not crash checkout; Upload from Gallery is available again after leaving the modal', async () => {
    mockGetUserMediaFailure('NotAllowedError');
    const onImageSelected = vi.fn().mockResolvedValue(undefined);
    render(<ImageUpload label="Payment Proof" required onImageSelected={onImageSelected} />);

    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));
    expect(await screen.findByText(/Camera access was blocked/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.change(galleryInput(), { target: { files: [jpegFile()] } });
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(onImageSelected).toHaveBeenCalledWith(expect.any(File), 'gallery_upload'));
  });

  it('shows a camera-unavailable message and never opens the file picker when getUserMedia is unsupported', () => {
    mockGetUserMediaUnsupported();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    const captureClickSpy = vi.fn();
    captureInput().addEventListener('click', captureClickSpy);

    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));

    expect(screen.getByText(/Camera is not available on this device\/browser/)).toBeInTheDocument();
    expect(captureClickSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('ImageUpload — upload image (gallery, unchanged by the camera modal)', () => {
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

  it('the gallery input carries no capture attribute and never triggers getUserMedia — always plain file selection', () => {
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);
    expect(galleryInput().hasAttribute('capture')).toBe(false);
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
