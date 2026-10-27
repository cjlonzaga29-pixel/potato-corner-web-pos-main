import type { LucideIcon } from 'lucide-react';

export interface NavChildItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

export interface NavItem {
  label: string;
  icon: LucideIcon;
  href?: string;
  /** Other route prefixes that belong to this item (old URLs it replaced); see isNavItemActive. */
  activePrefixes?: ReadonlyArray<string>;
  children?: ReadonlyArray<NavChildItem>;
}
