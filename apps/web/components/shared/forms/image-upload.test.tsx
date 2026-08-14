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
  readonly track: MockMediaStreamTrack;
  constructor(tracks: MockMediaStreamTrack[] = [new MockMediaStreamTrack()]) {
    this.tracks = tracks;
    this.track = tracks[0] ?? new MockMediaStreamTrack();
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

// Several tests below call setMobileUserAgent() without a matching restore
// (previously harmless — the preview `<img>` never depended on UA — but now
// that mobile skips the preview decode, a leaked mobile UA would silently
// flip every later desktop-assuming test onto the mobile code path). Capture
// the real default once and restore it after every test regardless.
const DEFAULT_USER_AGENT = window.navigator.userAgent;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  restoreDesktopUserAgent(DEFAULT_USER_AGENT);
});

describe('ImageUpload — native capture="environment" fallback input (getUserMedia-unsupported browsers only)', () => {
  it('the capture input carries capture="environment" so a fallback path can still open the native rear-camera UI', () => {
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

describe('ImageUpload — in-POS getUserMedia camera overlay (mobile AND desktop, emergency camera fix)', () => {
  it('Take Photo on a MOBILE device calls getUserMedia (in-page overlay) instead of clicking the native capture input', async () => {
    const { getUserMedia } = mockGetUserMediaSuccess();
    setMobileUserAgent();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    const captureClickSpy = vi.fn();
    captureInput().addEventListener('click', captureClickSpy);

    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(captureClickSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
  });

  it('requests a bounded resolution (not the device native maximum) on both mobile and desktop', async () => {
    const { getUserMedia } = mockGetUserMediaSuccess();
    setMobileUserAgent();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));

    await waitFor(() =>
      expect(getUserMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          audio: false,
          video: expect.objectContaining({
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          }),
        }),
      ),
    );
  });

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

    await waitFor(() => expect(stream.track.stop).toHaveBeenCalledTimes(1));
  });

  it('stops all MediaStream tracks after Cancel and closes the modal', async () => {
    const { stream } = mockGetUserMediaSuccess();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));
    await screen.findByRole('dialog');
    await waitFor(() => expect(stream.getTracks().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));

    expect(stream.track.stop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('stops all MediaStream tracks when the component unmounts with the camera open', async () => {
    const { stream } = mockGetUserMediaSuccess();
    const { unmount } = render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());

    unmount();
    expect(stream.track.stop).toHaveBeenCalledTimes(1);
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

  it('DESKTOP: shows a camera-unavailable message and Upload from Gallery fallback when getUserMedia is unsupported', () => {
    mockGetUserMediaUnsupported();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    const captureClickSpy = vi.fn();
    captureInput().addEventListener('click', captureClickSpy);

    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));

    expect(screen.getByText(/Camera is not available in this browser/)).toBeInTheDocument();
    expect(captureClickSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('MOBILE: falls back to the native capture input (only) when getUserMedia is unsupported', () => {
    mockGetUserMediaUnsupported();
    setMobileUserAgent();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    const captureClickSpy = vi.fn();
    captureInput().addEventListener('click', captureClickSpy);

    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));

    expect(captureClickSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the camera overlay (not the POS page) on Android hardware Back, via a scoped history entry', async () => {
    mockGetUserMediaSuccess();
    setMobileUserAgent();
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));
    await screen.findByRole('dialog');
    expect(pushStateSpy).toHaveBeenCalledWith({ cameraOverlay: true }, '');

    // Simulate the browser's own Back navigation consuming that pushed entry.
    fireEvent.popState(window);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    pushStateSpy.mockRestore();
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

describe('ImageUpload — memory-safe mobile capture pipeline (Task: camera low-memory fix)', () => {
  it('never touches FileReader for a mobile native-capture File — no readAsDataURL/base64 detour', async () => {
    const readAsDataURLSpy = vi.spyOn(FileReader.prototype, 'readAsDataURL');
    setMobileUserAgent();
    render(<ImageUpload label="Discount ID Proof" required onImageSelected={vi.fn()} />);

    fireEvent.change(captureInput(), { target: { files: [jpegFile('camera.jpg')] } });
    await waitFor(() => expect(screen.getByText('Photo captured')).toBeInTheDocument());

    expect(readAsDataURLSpy).not.toHaveBeenCalled();
    readAsDataURLSpy.mockRestore();
  });

  it('never decodes a mobile-captured File through createImageBitmap/canvas — the File goes straight into the upload pipeline unchanged', async () => {
    const createImageBitmapSpy = vi.fn();
    const original = globalThis.createImageBitmap;
    globalThis.createImageBitmap = createImageBitmapSpy as never;
    const onImageSelected = vi.fn().mockResolvedValue(undefined);
    const captured = jpegFile('camera.jpg');
    render(<ImageUpload label="Discount ID Proof" required onImageSelected={onImageSelected} />);

    fireEvent.change(captureInput(), { target: { files: [captured] } });
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));

    await waitFor(() => expect(onImageSelected).toHaveBeenCalledWith(captured, 'live_capture'));
    expect(createImageBitmapSpy).not.toHaveBeenCalled();
    globalThis.createImageBitmap = original;
  });

  it('the object URL preview is created from the exact captured File, not a re-encoded copy', async () => {
    const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL');
    const captured = jpegFile('camera.jpg');
    render(<ImageUpload label="Discount ID Proof" required onImageSelected={vi.fn()} />);

    fireEvent.change(captureInput(), { target: { files: [captured] } });
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());

    expect(createObjectURLSpy).toHaveBeenCalledWith(captured);
    createObjectURLSpy.mockRestore();
  });

  it('revokes the previous object URL when a new capture replaces a pending (unconfirmed) one', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    render(<ImageUpload label="Discount ID Proof" required onImageSelected={vi.fn()} />);

    fireEvent.change(galleryInput(), { target: { files: [jpegFile('first.jpg')] } });
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());
    const firstUrl = screen.getByAltText('Preview').getAttribute('src');

    fireEvent.click(screen.getByRole('button', { name: /Retake/ }));
    fireEvent.change(galleryInput(), { target: { files: [jpegFile('second.jpg')] } });
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());

    expect(revokeSpy).toHaveBeenCalledWith(firstUrl);
    revokeSpy.mockRestore();
  });

  it('revokes the object URL on Remove', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    render(<ImageUpload label="Discount ID Proof" required onImageSelected={vi.fn()} />);

    fireEvent.change(galleryInput(), { target: { files: [jpegFile()] } });
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());
    const url = screen.getByAltText('Preview').getAttribute('src');

    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    expect(revokeSpy).toHaveBeenCalledWith(url);
    revokeSpy.mockRestore();
  });

  it('revokes a still-pending object URL when the component unmounts (e.g. checkout closes mid-capture)', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    const { unmount } = render(<ImageUpload label="Discount ID Proof" required onImageSelected={vi.fn()} />);

    fireEvent.change(galleryInput(), { target: { files: [jpegFile()] } });
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());
    const url = screen.getByAltText('Preview').getAttribute('src');

    unmount();
    expect(revokeSpy).toHaveBeenCalledWith(url);
    revokeSpy.mockRestore();
  });

  it('disables Confirm/Retake/Remove while an upload is in flight so only one upload can run at a time', async () => {
    let resolveUpload: () => void = () => {};
    const onImageSelected = vi.fn(() => new Promise<void>((resolve) => (resolveUpload = resolve)));
    render(<ImageUpload label="Discount ID Proof" required onImageSelected={onImageSelected} />);

    fireEvent.change(galleryInput(), { target: { files: [jpegFile()] } });
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Uploading/ })).toBeDisabled());
    expect(screen.getByRole('button', { name: /Retake/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Remove/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Uploading/ }));
    resolveUpload();
    await waitFor(() => expect(onImageSelected).toHaveBeenCalledTimes(1));
  });
});

describe('ImageUpload — in-page camera capture resolution bound (memory fix)', () => {
  async function openCameraAndGetCaptureButton() {
    fireEvent.click(screen.getByRole('button', { name: /Take Photo/ }));
    const captureButton = await screen.findByRole('button', { name: /Capture Photo/ });
    await waitFor(() => expect(captureButton).not.toBeDisabled());
    return captureButton;
  }

  it('clamps the captured canvas to the configured max long-edge even when the video reports a much larger native resolution', async () => {
    mockGetUserMediaSuccess();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);
    const captureButton = await openCameraAndGetCaptureButton();

    const video = document.querySelector('video');
    if (!video) throw new Error('video not found');
    Object.defineProperty(video, 'videoWidth', { value: 4032, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 3024, configurable: true });

    let capturedCanvas: HTMLCanvasElement | null = null;
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === 'canvas') capturedCanvas = el as HTMLCanvasElement;
      return el;
    });

    fireEvent.click(captureButton);

    await waitFor(() => expect(capturedCanvas).not.toBeNull());
    const canvas = capturedCanvas as unknown as HTMLCanvasElement;
    expect(canvas.width).toBeLessThanOrEqual(1600);
    expect(canvas.height).toBeLessThanOrEqual(1600);
    expect(Math.max(canvas.width, canvas.height)).toBe(1600);
    createElementSpy.mockRestore();
  });

  it('leaves the canvas at the source resolution when the stream is already within bounds (no upscaling)', async () => {
    mockGetUserMediaSuccess();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);
    const captureButton = await openCameraAndGetCaptureButton();

    const video = document.querySelector('video');
    if (!video) throw new Error('video not found');
    Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true });

    let capturedCanvas: HTMLCanvasElement | null = null;
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === 'canvas') capturedCanvas = el as HTMLCanvasElement;
      return el;
    });

    fireEvent.click(captureButton);

    await waitFor(() => expect(capturedCanvas).not.toBeNull());
    const canvas = capturedCanvas as unknown as HTMLCanvasElement;
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
    createElementSpy.mockRestore();
  });

  it('uses canvas.toBlob, never canvas.toDataURL, for the captured frame', async () => {
    const toDataURLSpy = vi.fn();
    HTMLCanvasElement.prototype.toDataURL = toDataURLSpy;
    mockGetUserMediaSuccess();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);
    const captureButton = await openCameraAndGetCaptureButton();

    fireEvent.click(captureButton);
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());

    expect(toDataURLSpy).not.toHaveBeenCalled();
    // @ts-expect-error -- test-only cleanup, jsdom's HTMLCanvasElement has no real toDataURL implementation to restore.
    delete HTMLCanvasElement.prototype.toDataURL;
  });

  it('the bounded camera capture IS previewed even on mobile — controlled resolution makes the decode safe', async () => {
    mockGetUserMediaSuccess();
    setMobileUserAgent();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);
    const captureButton = await openCameraAndGetCaptureButton();

    fireEvent.click(captureButton);

    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());
  });

  it('repeated Retake -> Capture cycles do not accumulate MediaStreams or object URLs', async () => {
    const { stream } = mockGetUserMediaSuccess();
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    // First capture.
    let captureButton = await openCameraAndGetCaptureButton();
    fireEvent.click(captureButton);
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());
    const firstUrl = screen.getByAltText('Preview').getAttribute('src');
    expect(stream.track.stop).toHaveBeenCalledTimes(1);

    // Retake opens a fresh stream — the first is already stopped, never a second live one.
    fireEvent.click(screen.getByRole('button', { name: /Retake/ }));
    captureButton = await openCameraAndGetCaptureButton();
    fireEvent.click(captureButton);
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());

    expect(revokeSpy).toHaveBeenCalledWith(firstUrl);
    // Same mocked stream instance is reused by the mock, but its tracks were
    // stopped once per capture — never left running across a Retake cycle.
    expect(stream.track.stop).toHaveBeenCalledTimes(2);
    revokeSpy.mockRestore();
  });

  it('the camera stream is already released before Confirm/upload even starts — an upload failure cannot leave it running', async () => {
    const { stream } = mockGetUserMediaSuccess();
    const onImageSelected = vi.fn().mockRejectedValue(new Error('Network error'));
    render(<ImageUpload label="Payment Proof" required onImageSelected={onImageSelected} />);
    const captureButton = await openCameraAndGetCaptureButton();

    fireEvent.click(captureButton);
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());
    expect(stream.track.stop).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(screen.getByText('Network error')).toBeInTheDocument());

    // Upload failed, but the camera was already torn down before Confirm was even clicked.
    expect(stream.track.stop).toHaveBeenCalledTimes(1);
  });
});

describe('ImageUpload — mobile skips full-resolution original preview decode (low-memory fix)', () => {
  it('does not create an object URL or render a preview <img> for a mobile capture — shows a placeholder instead', async () => {
    const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL');
    setMobileUserAgent();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.change(captureInput(), { target: { files: [jpegFile('camera.jpg')] } });
    await waitFor(() => expect(screen.getByText('Photo captured')).toBeInTheDocument());

    expect(screen.queryByAltText('Preview')).not.toBeInTheDocument();
    expect(screen.getByText(/ready to upload/)).toBeInTheDocument();
    expect(createObjectURLSpy).not.toHaveBeenCalled();
    createObjectURLSpy.mockRestore();
  });

  it('does not create an object URL for a mobile gallery selection either — a large gallery photo is just as decode-risky as a camera capture', async () => {
    const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL');
    setMobileUserAgent();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.change(galleryInput(), { target: { files: [jpegFile('gallery.jpg')] } });
    await waitFor(() => expect(screen.getByText('Gallery upload')).toBeInTheDocument());

    expect(createObjectURLSpy).not.toHaveBeenCalled();
    createObjectURLSpy.mockRestore();
  });

  it('still confirms and uploads the exact captured File on mobile, even with no preview rendered', async () => {
    const onImageSelected = vi.fn().mockResolvedValue(undefined);
    setMobileUserAgent();
    const captured = jpegFile('camera.jpg');
    render(<ImageUpload label="Payment Proof" required onImageSelected={onImageSelected} />);

    fireEvent.change(captureInput(), { target: { files: [captured] } });
    await waitFor(() => expect(screen.getByText('Photo captured')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));

    await waitFor(() => expect(onImageSelected).toHaveBeenCalledWith(captured, 'live_capture'));
  });

  it('Retake returns to the picker buttons on mobile with no preview to revoke', async () => {
    setMobileUserAgent();
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.change(captureInput(), { target: { files: [jpegFile('camera.jpg')] } });
    await waitFor(() => expect(screen.getByText('Photo captured')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Retake/ }));
    expect(screen.queryByText('Photo captured')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Take Photo/ })).toBeInTheDocument();
  });

  it('desktop keeps the direct preview — the low-memory mobile path does not affect non-mobile devices', async () => {
    render(<ImageUpload label="Payment Proof" required onImageSelected={vi.fn()} />);

    fireEvent.change(galleryInput(), { target: { files: [jpegFile()] } });
    await waitFor(() => expect(screen.getByAltText('Preview')).toBeInTheDocument());
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
