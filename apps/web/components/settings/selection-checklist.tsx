'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface ChecklistOption {
  id: string;
  label: string;
  /** Selected and shown, but can't be changed here. */
  locked?: boolean;
}

interface SelectionChecklistProps {
  title: string;
  /** Plural noun for counts and the select-all label, e.g. "branches". */
  noun: string;
  options: readonly ChecklistOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  searchable?: boolean;
  error?: string | null;
}

/**
 * POS-PERF-P57 — a checklist with Select all, Clear, a count and a partial
 * state. While a search is typed, Select all acts on the results shown and says
 * so; ticks made earlier for other results are kept. UI only: the server
 * re-checks authority over everything it is sent.
 */
export function SelectionChecklist({ title, noun, options, selected, onChange, searchable, error }: SelectionChecklistProps) {
  const headingId = useId();
  const searchId = useId();
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const shown = query ? options.filter((option) => option.label.toLowerCase().includes(query)) : options;
  const editableShownIds = shown.filter((option) => !option.locked).map((option) => option.id);
  const selectedSet = new Set(selected);
  const shownSelected = editableShownIds.filter((id) => selectedSet.has(id)).length;
  const headerState = shownSelected === 0 ? false : shownSelected === editableShownIds.length ? true : 'indeterminate';
  const lockedIds = options.filter((option) => option.locked).map((option) => option.id);

  function toggle(id: string, checked: boolean) {
    onChange(checked ? [...new Set([...selected, id])] : selected.filter((value) => value !== id));
  }

  function setAllShown(checked: boolean) {
    const ids = new Set(editableShownIds);
    onChange(checked ? [...new Set([...selected, ...editableShownIds])] : selected.filter((value) => !ids.has(value)));
  }

  return (
    <fieldset className="space-y-2 rounded-md border p-3" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={headingId} className="text-sm font-medium">
          {title}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {selected.length} of {options.length} selected
        </span>
      </div>
      {searchable && (
        <div className="space-y-1">
          <Label htmlFor={searchId} className="sr-only">
            Search {noun}
          </Label>
          <Input id={searchId} value={search} placeholder={`Search ${noun}…`} onChange={(event) => setSearch(event.target.value)} />
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <Checkbox
            checked={headerState}
            disabled={editableShownIds.length === 0}
            onCheckedChange={(checked) => setAllShown(checked === true)}
            aria-label={query ? `Select all ${shown.length} ${noun} shown` : `Select all ${options.length} ${noun}`}
          />
          {query ? `Select all ${shown.length} shown` : `Select all ${options.length} ${noun}`}
        </label>
        <Button type="button" variant="ghost" size="sm" disabled={selected.length === lockedIds.length} onClick={() => onChange(lockedIds)}>
          Clear selection
        </Button>
      </div>
      {query && <p className="text-xs text-muted-foreground">Select all applies to these search results only. Items you ticked earlier stay ticked.</p>}
      <ul className="max-h-48 space-y-0.5 overflow-y-auto">
        {shown.map((option) => (
          <li key={option.id}>
            <label className="flex min-h-9 items-center gap-2 rounded px-1 text-sm hover:bg-muted/40">
              <Checkbox checked={selectedSet.has(option.id)} disabled={option.locked} onCheckedChange={(checked) => toggle(option.id, checked === true)} aria-label={option.label} />
              <span className="min-w-0 break-words">{option.label}</span>
            </label>
          </li>
        ))}
        {shown.length === 0 && <li className="px-1 py-2 text-sm text-muted-foreground">Nothing matches.</li>}
      </ul>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
