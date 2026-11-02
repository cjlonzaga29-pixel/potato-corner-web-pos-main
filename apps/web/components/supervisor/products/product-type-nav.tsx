'use client';

import { useEffect, useRef } from 'react';
import type { ProductTypeResponse } from '@potato-corner/shared';
import { cn } from '@/lib/utils';

export const ALL_PRODUCT_TYPES = 'all';

interface ProductTypeNavProps {
  types: ProductTypeResponse[];
  selected: string;
  /** Products per type key in the current tab and search; absent while loading or from an older API. */
  typeCounts?: Record<string, number>;
  onSelect: (key: string) => void;
}

/**
 * POS-PERF-P58 — All Types, the built-ins, then custom types. Plain buttons in a
 * wrapping list: any number of types stays reachable by keyboard without sideways
 * scrolling, and past a few rows the list scrolls within its own height.
 */
export function ProductTypeNav({ types, selected, typeCounts, onSelect }: ProductTypeNavProps) {
  const list = useRef<HTMLUListElement>(null);
  // A selection from the URL may be past what the list shows; keep it in view, moving only this list.
  useEffect(() => {
    const current = list.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (list.current && current) list.current.scrollTop = current.offsetTop - 4;
  }, [selected, types.length]);

  const total = typeCounts ? Object.values(typeCounts).reduce((sum, count) => sum + count, 0) : undefined;
  const entries = [
    { key: ALL_PRODUCT_TYPES, name: 'All Types', is_active: true, count: total },
    ...types.map((type) => ({ key: type.key, name: type.name, is_active: type.is_active, count: typeCounts ? (typeCounts[type.key] ?? 0) : undefined })),
  ];
  return (
    <nav aria-label="Product types">
      <ul ref={list} className="relative flex max-h-32 flex-wrap gap-1.5 overflow-y-auto p-0.5" data-testid="product-type-nav">
        {entries.map((entry) => {
          const current = entry.key === selected;
          return (
            <li key={entry.key} className="min-w-0 max-w-full">
              <button
                type="button"
                aria-current={current ? 'true' : undefined}
                title={entry.name}
                data-testid={`product-type-nav-${entry.key}`}
                onClick={() => onSelect(entry.key)}
                className={cn(
                  'inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  current ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted',
                )}
              >
                <span className="truncate">{entry.name}</span>
                {!entry.is_active && <span className={cn('shrink-0 text-xs', !current && 'text-muted-foreground')}>(inactive)</span>}
                <span className={cn('shrink-0 rounded-full px-1.5 text-xs tabular-nums', current ? 'bg-primary-foreground/20' : 'bg-muted text-muted-foreground')}>{entry.count ?? '–'}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
