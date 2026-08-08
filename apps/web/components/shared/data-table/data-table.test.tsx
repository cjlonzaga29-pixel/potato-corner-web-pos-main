import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from './data-table';

afterEach(cleanup);

interface Row {
  id: string;
  name: string;
}

const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: 'id', header: 'ID' },
  { accessorKey: 'name', header: 'Name' },
];

const data: Row[] = [{ id: '1', name: 'Alpha' }];

// Task 209.10 — stickyHeader is an opt-in prop so the 37+ non-report
// DataTable call sites keep their exact current markup/behavior.
describe('DataTable — stickyHeader (Task 209.10, opt-in)', () => {
  it('does not add sticky positioning classes when stickyHeader is omitted (default false)', () => {
    render(<DataTable columns={columns} data={data} />);

    const headerRow = screen.getByRole('columnheader', { name: 'ID' }).closest('tr');
    expect(headerRow?.className ?? '').not.toContain('sticky');
  });

  it('adds sticky positioning to the header and a bounded, scrollable container when stickyHeader is true', () => {
    render(<DataTable columns={columns} data={data} stickyHeader maxBodyHeight="50vh" />);

    const headerRow = screen.getByRole('columnheader', { name: 'ID' }).closest('tr');
    const headerGroup = headerRow?.closest('thead');
    expect(headerGroup?.className ?? '').toContain('sticky');
    expect(headerGroup?.className ?? '').toContain('top-0');

    const scrollContainer = headerGroup?.closest('div');
    expect(scrollContainer?.className ?? '').toContain('overflow-y-auto');
    expect(scrollContainer?.getAttribute('style') ?? '').toContain('50vh');
  });
});
