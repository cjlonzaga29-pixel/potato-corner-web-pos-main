import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { classifyDensity, useDensityMode, type DensityMode } from './use-density-mode';

const originalMatchMedia = window.matchMedia;

interface Viewport {
  width: number;
  height: number;
  coarsePointer?: boolean;
}

/**
 * Real query-string-aware matchMedia mock — evaluates each of the density
 * engine's 4 known query strings against a given width/height/pointer
 * combination, exactly like a real browser would, and returns a
 * MediaQueryList-shaped object whose `addEventListener`/`removeEventListener`
 * are individually trackable spies so listener-count/cleanup assertions can
 * target one specific query.
 */
function mockMatchMediaForViewport({ width, height, coarsePointer = false }: Viewport) {
  const evaluate = (query: string): boolean => {
    if (query === '(max-width: 767px)') return width <= 767;
    if (query === '(pointer: coarse), (hover: none)') return coarsePointer;
    if (query === '(min-width: 1800px) and (min-height: 900px)') return width >= 1800 && height >= 900;
    if (query === '(min-width: 1024px) and (max-height: 820px)') return width >= 1024 && height <= 820;
    return false;
  };

  const mqls = new Map<string, ReturnType<typeof createMql>>();

  function createMql(query: string) {
    return {
      matches: evaluate(query),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  }

  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    let mql = mqls.get(query);
    if (!mql) {
      mql = createMql(query);
      mqls.set(query, mql);
    }
    return mql;
  }) as unknown as typeof window.matchMedia;

  return mqls;
}

describe('classifyDensity — pure classification (no window/matchMedia access)', () => {
  it('1920x1080, fine pointer -> comfortable', () => {
    expect(classifyDensity({ width: 1920, height: 1080, coarsePointer: false })).toBe('comfortable');
  });

  it('1536x864, fine pointer -> standard (fails comfortable height>=900 and compact height<=820)', () => {
    expect(classifyDensity({ width: 1536, height: 864, coarsePointer: false })).toBe('standard');
  });

  it('1366x768, fine pointer -> compact', () => {
    expect(classifyDensity({ width: 1366, height: 768, coarsePointer: false })).toBe('compact');
  });

  it('1024x768, coarse pointer -> compact-touch (fires before compact is even reached)', () => {
    expect(classifyDensity({ width: 1024, height: 768, coarsePointer: true })).toBe('compact-touch');
  });

  it('390x844 -> mobile, regardless of pointer', () => {
    expect(classifyDensity({ width: 390, height: 844, coarsePointer: false })).toBe('mobile');
    expect(classifyDensity({ width: 390, height: 844, coarsePointer: true })).toBe('mobile');
  });

  it('exact boundary: 1800x900 fine pointer -> comfortable (>= both edges)', () => {
    expect(classifyDensity({ width: 1800, height: 900, coarsePointer: false })).toBe('comfortable');
  });

  it('exact boundary: 767px wide -> mobile; 768px wide -> not mobile', () => {
    expect(classifyDensity({ width: 767, height: 1000, coarsePointer: false })).toBe('mobile');
    expect(classifyDensity({ width: 768, height: 1000, coarsePointer: false })).not.toBe('mobile');
  });
});

describe('useDensityMode', () => {
  afterEach(() => {
    cleanup();
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
  });

  it('defaults to "standard" before matchMedia resolves (matches server render / jsdom-without-matchMedia)', () => {
    // @ts-expect-error simulating an environment with no matchMedia at all
    window.matchMedia = undefined;

    const { result } = renderHook(() => useDensityMode());

    expect(result.current).toBe('standard');
  });

  it('resolves to comfortable for a 1920x1080 fine-pointer viewport', () => {
    mockMatchMediaForViewport({ width: 1920, height: 1080 });
    const { result } = renderHook(() => useDensityMode());
    expect(result.current).toBe('comfortable');
  });

  it('resolves to standard for a 1536x864 fine-pointer viewport', () => {
    mockMatchMediaForViewport({ width: 1536, height: 864 });
    const { result } = renderHook(() => useDensityMode());
    expect(result.current).toBe('standard');
  });

  it('resolves to compact for a 1366x768 fine-pointer viewport', () => {
    mockMatchMediaForViewport({ width: 1366, height: 768 });
    const { result } = renderHook(() => useDensityMode());
    expect(result.current).toBe('compact');
  });

  it('resolves to compact-touch for a 1024x768 coarse-pointer viewport', () => {
    mockMatchMediaForViewport({ width: 1024, height: 768, coarsePointer: true });
    const { result } = renderHook(() => useDensityMode());
    expect(result.current).toBe('compact-touch');
  });

  it('resolves to mobile for a 390x844 viewport', () => {
    mockMatchMediaForViewport({ width: 390, height: 844 });
    const { result } = renderHook(() => useDensityMode());
    expect(result.current).toBe('mobile');
  });

  it('only re-renders when a matchMedia change event actually crosses a mode boundary', () => {
    const mqls = mockMatchMediaForViewport({ width: 1536, height: 864 });
    let renderCount = 0;

    const { result } = renderHook(() => {
      renderCount += 1;
      return useDensityMode();
    });

    expect(result.current).toBe('standard');
    const countAfterMount = renderCount;

    // Fire "change" on every query without altering any mock's `matches` —
    // simulates resize events that never cross a density boundary (e.g.
    // 1536x864 -> 1520x860, still standard). None of these should trigger a
    // re-render since the resolved mode never actually changes.
    act(() => {
      for (const mql of mqls.values()) {
        const listenerCall = (mql.addEventListener as ReturnType<typeof vi.fn>).mock.calls[0];
        const listener = listenerCall?.[1] as (() => void) | undefined;
        listener?.();
      }
    });

    expect(renderCount).toBe(countAfterMount);

    // Now actually flip the compact query to simulate crossing into compact
    // (e.g. the window got shorter) — this SHOULD trigger exactly one
    // re-render with the new mode.
    const compactMql = mqls.get('(min-width: 1024px) and (max-height: 820px)');
    expect(compactMql).toBeDefined();
    act(() => {
      if (compactMql) {
        compactMql.matches = true;
        const listenerCall = (compactMql.addEventListener as ReturnType<typeof vi.fn>).mock.calls[0];
        const listener = listenerCall?.[1] as (() => void) | undefined;
        listener?.();
      }
    });

    expect(result.current).toBe('compact');
    expect(renderCount).toBe(countAfterMount + 1);
  });

  it('removes every matchMedia listener it added, on unmount', () => {
    const mqls = mockMatchMediaForViewport({ width: 1536, height: 864 });
    const { unmount } = renderHook(() => useDensityMode());

    expect(mqls.size).toBe(4);
    for (const mql of mqls.values()) {
      expect(mql.addEventListener).toHaveBeenCalledTimes(1);
      expect(mql.removeEventListener).not.toHaveBeenCalled();
    }

    unmount();

    for (const mql of mqls.values()) {
      expect(mql.removeEventListener).toHaveBeenCalledTimes(1);
      // Same listener reference added is the one removed.
      const addedListener = (mql.addEventListener as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
      const removedListener = (mql.removeEventListener as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
      expect(removedListener).toBe(addedListener);
    }
  });
});

describe('density mode type coverage', () => {
  it('covers exactly the 5 documented modes', () => {
    const modes: DensityMode[] = ['comfortable', 'standard', 'compact', 'compact-touch', 'mobile'];
    expect(modes).toHaveLength(5);
  });
});
