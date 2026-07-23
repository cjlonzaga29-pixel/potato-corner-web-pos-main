'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DialogTitle } from '@/components/ui/dialog';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import type { NavItem } from '@/components/shared/nav-types';

interface NavSearchCommandProps {
  items: ReadonlyArray<NavItem>;
}

/** Cmd/Ctrl+K palette over a static nav tree — page navigation only, not a business-data search. */
export function NavSearchCommand({ items }: NavSearchCommandProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <>
      <Button
        variant="outline"
        className="h-9 w-full max-w-sm justify-start gap-2 rounded-lg text-sm text-muted-foreground sm:pr-12"
        onClick={() => setOpen(true)}
      >
        <Search className="h-4 w-4" />
        <span className="truncate">Search pages...</span>
        <kbd className="pointer-events-none ml-auto hidden select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
          <span className="text-xs">Ctrl</span>K
        </kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <DialogTitle className="sr-only">Search pages</DialogTitle>
        <CommandInput placeholder="Jump to a page..." />
        <CommandList>
          <CommandEmpty>No matching page.</CommandEmpty>
          <CommandGroup heading="Pages">
            {items.flatMap((item) =>
              item.href
                ? [
                    <CommandItem key={item.href} value={item.label} onSelect={() => go(item.href as string)}>
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </CommandItem>,
                  ]
                : (item.children ?? []).map((child) => (
                    <CommandItem key={child.href} value={`${item.label} ${child.label}`} onSelect={() => go(child.href)}>
                      <child.icon className="h-4 w-4" />
                      {item.label} / {child.label}
                    </CommandItem>
                  )),
            )}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
