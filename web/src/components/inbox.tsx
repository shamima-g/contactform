'use client';

import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/status-badge';
import { CATEGORIES, STATUSES } from '@/types/domain';
import type { Category, Enquiry, EnquiryQuery, Status } from '@/types/domain';
import { listAllEnquiries } from '@/lib/api/enquiries';

const PAGE_SIZE = 5;

type SortBy = NonNullable<EnquiryQuery['sortBy']>;

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}

export function Inbox() {
  const [category, setCategory] = useState<Category | 'all'>('all');
  const [status, setStatus] = useState<Status | 'all'>('all');
  const [sortBy, setSortBy] = useState<SortBy>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<{
    items: Enquiry[];
    total: number;
  } | null>(null);

  useEffect(() => {
    let active = true;
    listAllEnquiries({
      category,
      status,
      sortBy,
      sortDir,
      page,
      pageSize: PAGE_SIZE,
    }).then((res) => {
      if (active) setResult({ items: res.items, total: res.total });
    });
    return () => {
      active = false;
    };
  }, [category, status, sortBy, sortDir, page]);

  const loading = result === null;
  const items = result?.items ?? [];
  const total = result?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleSort = (column: SortBy) => {
    if (sortBy === column) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(column);
      setSortDir('asc');
    }
    setPage(1);
  };

  const sortIcon = (column: SortBy) => {
    if (sortBy !== column) return <ArrowUpDown className="h-3.5 w-3.5" />;
    return sortDir === 'asc' ? (
      <ArrowUp className="h-3.5 w-3.5" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5" />
    );
  };

  const ariaSort = (column: SortBy): 'ascending' | 'descending' | 'none' =>
    sortBy === column
      ? sortDir === 'asc'
        ? 'ascending'
        : 'descending'
      : 'none';

  const clearFilters = () => {
    setCategory('all');
    setStatus('all');
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <p className="text-muted-foreground">
          Every enquiry from every visitor. Filter, sort, and work through them.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="filter-status">Status</Label>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as Status | 'all');
              setPage(1);
            }}
          >
            <SelectTrigger
              id="filter-status"
              className="w-44"
              aria-label="Filter by status"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="filter-category">Category</Label>
          <Select
            value={category}
            onValueChange={(value) => {
              setCategory(value as Category | 'all');
              setPage(1);
            }}
          >
            <SelectTrigger
              id="filter-category"
              className="w-48"
              aria-label="Filter by category"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {(category !== 'all' || status !== 'all') && (
          <Button variant="ghost" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={ariaSort('name')}>
                <button
                  type="button"
                  className="flex items-center gap-1"
                  onClick={() => toggleSort('name')}
                >
                  Submitter {sortIcon('name')}
                </button>
              </TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Status</TableHead>
              <TableHead aria-sort={ariaSort('createdAt')}>
                <button
                  type="button"
                  className="flex items-center gap-1"
                  onClick={() => toggleSort('createdAt')}
                >
                  Submitted {sortIcon('createdAt')}
                </button>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!loading && items.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="py-10 text-center text-muted-foreground"
                >
                  No enquiries match the current filters.
                </TableCell>
              </TableRow>
            ) : (
              items.map((enquiry) => (
                <TableRow key={enquiry.id}>
                  <TableCell>
                    <div className="font-medium">{enquiry.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {enquiry.email}
                    </div>
                  </TableCell>
                  <TableCell>{enquiry.category}</TableCell>
                  <TableCell>
                    <StatusBadge status={enquiry.status} />
                  </TableCell>
                  <TableCell>{formatDate(enquiry.createdAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {total} enquir{total === 1 ? 'y' : 'ies'} · page {page} of{' '}
          {totalPages}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
