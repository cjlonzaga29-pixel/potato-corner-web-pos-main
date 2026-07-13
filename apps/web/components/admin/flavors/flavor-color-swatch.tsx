import { cn } from '@/lib/utils';

interface FlavorColorSwatchProps {
  colorHex: string | null;
  className?: string;
}

export function FlavorColorSwatch({ colorHex, className }: FlavorColorSwatchProps) {
  return (
    <span
      className={cn('inline-block h-4 w-4 shrink-0 rounded-full border', className)}
      style={{ backgroundColor: colorHex ?? undefined }}
      aria-hidden="true"
    />
  );
}
