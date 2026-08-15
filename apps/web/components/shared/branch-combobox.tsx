'use client';

import { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';

export interface BranchComboboxOption {
  id: string;
  name: string;
  code: string;
}

interface BranchComboboxProps {
  branches: BranchComboboxOption[];
  value: string | undefined;
  onChange: (branchId: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Searchable "Branch Name — Branch Code" picker — the human-readable
 * replacement for asking the user to type a raw branch UUID. Callers submit
 * the selected option's canonical `id`; the UUID never appears in the UI.
 */
export function BranchCombobox({ branches, value, onChange, placeholder = 'Select branch...', disabled }: BranchComboboxProps) {
  const [open, setOpen] = useState(false);
  const selected = branches.find((b) => b.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          {selected ? `${selected.name} — ${selected.code}` : placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command>
          <CommandInput placeholder="Search branches..." />
          <CommandList>
            <CommandEmpty>No branch found.</CommandEmpty>
            <CommandGroup>
              {branches.map((branch) => (
                <CommandItem
                  key={branch.id}
                  value={`${branch.name} ${branch.code}`}
                  onSelect={() => {
                    onChange(branch.id);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mr-2 h-4 w-4', branch.id === value ? 'opacity-100' : 'opacity-0')} />
                  {branch.name} — {branch.code}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
