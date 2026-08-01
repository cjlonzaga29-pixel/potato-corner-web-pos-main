import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { triggerBrowserDownload } from './trigger-download';

const originalCreateElement = document.createElement.bind(document);

/** Spies on document.createElement('a') so click()/remove() can be observed without jsdom actually navigating. */
function spyOnAnchor(clickSpy: ReturnType<typeof vi.fn>, removeSpy: ReturnType<typeof vi.fn>) {
  return vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = originalCreateElement(tag) as HTMLAnchorElement;
    if (tag === 'a') {
      el.click = clickSpy;
      el.remove = removeSpy;
    }
    return el;
  });
}

describe('triggerBrowserDownload', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    createObjectURL = vi.fn(() => 'blob:mock-url');
    revokeObjectURL = vi.fn();
    // jsdom doesn't implement these.
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates an object URL from the blob', () => {
    const blob = new Blob(['a,b,c'], { type: 'text/csv' });
    triggerBrowserDownload(blob, 'report.csv');
    expect(createObjectURL).toHaveBeenCalledWith(blob);
  });

  it('appends an anchor with the correct href/download, clicks it, then removes it', () => {
    const appendSpy = vi.spyOn(document.body, 'appendChild');
    const clickSpy = vi.fn();
    const removeSpy = vi.fn();
    spyOnAnchor(clickSpy, removeSpy);

    triggerBrowserDownload(new Blob(['data'], { type: 'text/csv' }), 'my-report.csv');

    expect(appendSpy).toHaveBeenCalled();
    const appendedLink = appendSpy.mock.calls[0]?.[0] as HTMLAnchorElement;
    expect(appendedLink.href).toBe('blob:mock-url');
    expect(appendedLink.download).toBe('my-report.csv');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not revoke the object URL before click() fires', () => {
    const clickSpy = vi.fn(() => {
      // At the moment of click, the URL must not have been revoked yet.
      expect(revokeObjectURL).not.toHaveBeenCalled();
    });
    spyOnAnchor(clickSpy, vi.fn());

    triggerBrowserDownload(new Blob(['data'], { type: 'application/pdf' }), 'report.pdf');

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('revokes the object URL only after a delay', () => {
    spyOnAnchor(vi.fn(), vi.fn());

    triggerBrowserDownload(new Blob(['data'], { type: 'text/csv' }), 'report.csv');

    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(999);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});
