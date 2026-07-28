import { cn } from '@/lib/utils';

// CR-010 categories are admin-created free text, not a fixed enum — this maps
// well-known Potato Corner category names to a stable color and falls back to
// a deterministic cycle so any custom category still gets a consistent badge.
const KNOWN_CATEGORY_COLORS: Record<string, string> = {
  'raw ingredients': 'bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400',
  'flavor seasonings': 'bg-yellow-500/15 text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-400',
  packaging: 'bg-blue-500/15 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400',
  'cooking supplies': 'bg-orange-500/15 text-orange-700 dark:bg-orange-500/20 dark:text-orange-400',
  consumables: 'bg-purple-500/15 text-purple-700 dark:bg-purple-500/20 dark:text-purple-400',
  beverages: 'bg-cyan-500/15 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-400',
};

const FALLBACK_COLORS = Object.values(KNOWN_CATEGORY_COLORS);

function colorForCategory(name: string): string {
  const known = KNOWN_CATEGORY_COLORS[name.trim().toLowerCase()];
  if (known) return known;

  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length] ?? FALLBACK_COLORS[0] ?? '';
}

interface InventoryCategoryBadgeProps {
  category: string | null;
  className?: string;
}

export function InventoryCategoryBadge({ category, className }: InventoryCategoryBadgeProps) {
  if (!category) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',
        colorForCategory(category),
        className,
      )}
    >
      {category}
    </div>
  );
}
