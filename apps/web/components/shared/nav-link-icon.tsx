'use client';

import { useLinkStatus } from 'next/link';
import { Loader2, type LucideIcon } from 'lucide-react';

/**
 * Must render as a child of next/link's <Link> — useLinkStatus reads context
 * set by the nearest Link ancestor. Swaps to a spinner while that Link's
 * navigation is pending, so a slow middleware/auth round-trip on click reads
 * as "loading" instead of the sidebar looking unresponsive.
 */
export function NavLinkIcon({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  const { pending } = useLinkStatus();
  if (pending) return <Loader2 className={className ? `${className} animate-spin` : 'animate-spin'} />;
  return <Icon className={className} />;
}
