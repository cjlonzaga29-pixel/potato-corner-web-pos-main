import type { PosCatalogProduct } from '@potato-corner/shared';

type CatalogVariant = PosCatalogProduct['variants'][number];
type StockShortage = NonNullable<CatalogVariant['stock_shortages']>[number];

/** Cashier-facing reason a variant failed its setup checks, or null when it is live_ready. Setup, never stock: a stock shortage has its own message below. */
export function readinessMessage(variant: CatalogVariant): string | null {
  if (variant.live_ready) return null;
  if (variant.readiness_code === 'MISSING_FLAVOR_MAPPING') {
    const flavorNames = variant.blocking_issues.map((issue) => issue.flavor_name).filter((name): name is string => Boolean(name));
    if (flavorNames.length > 0) return `Not ready: missing setup for ${flavorNames.join(', ')}.`;
    return 'Flavor inventory mapping incomplete.';
  }
  switch (variant.readiness_code) {
    case 'NOT_AVAILABLE_IN_BRANCH':
      return 'Not available at this branch.';
    case 'INACTIVE':
      return 'Currently unavailable.';
    case 'PRICE_MISSING':
      return 'Price not set.';
    case 'MIX_MAX_INCOMPLETE':
      return 'Mix & Max setup incomplete.';
    case 'MISSING_BASE_MAPPING':
    default:
      return 'Inventory setup incomplete.';
  }
}

function shortageReason(shortage: StockShortage): string {
  const unit = shortage.unit_code ? ` ${shortage.unit_code}` : '';
  if (shortage.reason === 'not_assigned') return `${shortage.name} is not assigned to this branch`;
  // Checkout reserves every recipe line, tracked or not, so an untracked item with no balance still blocks the sale.
  if (!shortage.track_inventory) return `${shortage.name} is not tracked, but its recipe still needs stock here`;
  if (shortage.reason === 'no_stock') return `${shortage.name} is out of stock`;
  if (shortage.reason === 'fully_reserved') return `${shortage.name} is fully reserved by pending sales`;
  return `${shortage.name}: ${shortage.available}${unit} available, ${shortage.required}${unit} needed for one`;
}

/** Short card label naming what is missing, or null when the variant isn't confirmed out of stock (or the API predates stock_shortages). */
export function stockShortageLabel(variant: CatalogVariant): string | null {
  if (variant.stock_status !== 'out_of_stock') return null;
  const names = (variant.stock_shortages ?? []).map((s) => s.name);
  return names.length > 0 ? `Short: ${names.join(', ')}` : null;
}

/** Every missing ingredient in a sentence, for the toast and the dashboard. */
export function stockShortageDetail(variant: CatalogVariant): string | null {
  if (variant.stock_status !== 'out_of_stock') return null;
  const shortages = variant.stock_shortages ?? [];
  if (shortages.length === 0) return null;
  return `${shortages.map(shortageReason).join('; ')}.`;
}
