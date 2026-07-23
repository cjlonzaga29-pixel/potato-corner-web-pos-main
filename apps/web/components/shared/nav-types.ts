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
  children?: ReadonlyArray<NavChildItem>;
}
