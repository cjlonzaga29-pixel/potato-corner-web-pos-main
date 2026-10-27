/**
 * POS-PERF-P39 — the one box every POS catalog tile uses, shared by
 * ProductCard and ProductCardSkeleton so a loading tile has exactly the
 * loaded tile's geometry. The image area's ratio comes from
 * `.app-pos-card-image` (globals.css); every text row below it has a fixed
 * height, so a tile's height never depends on its name, its size label, its
 * photo or its badges — only on its width, which the grid sets.
 */
export const POS_CARD_CLASSES = {
  frame: 'app-pos-card flex flex-col self-start overflow-hidden rounded-xl border shadow-none',
  image: 'app-pos-card-image relative flex w-full items-center justify-center overflow-hidden bg-muted/40',
  body: 'flex flex-col gap-1 p-2',
  /** Two lines of `text-sm leading-tight`, reserved even for a one-line name. */
  name: 'h-[2.25rem]',
  /** One line of `text-xs`. */
  size: 'h-4',
  /** One line of `text-sm` price. */
  price: 'h-5',
  /** The unavailable-reason slot, reserved on every tile so an unavailable tile is never taller. */
  message: 'h-6',
} as const;
