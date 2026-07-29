/**
 * Story 4 — Back-office inbox. Covers the empty-filter state (jsdom) and the
 * data layer's filter / sort / pagination logic. The full browser round-trip
 * (filter narrows, sort reorders, paging moves) is covered by the Playwright
 * spec.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({
    user: {
      email: 'agent@example.com',
      role: 'Support Agent',
      name: 'Sam Agent',
    },
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/lib/api/enquiries', () => ({ listAllEnquiries: vi.fn() }));

import { listAllEnquiries } from '@/lib/api/enquiries';
import { Inbox } from '@/components/inbox';
import { listAll, __resetStore } from '@/lib/data/store';

beforeEach(() => {
  vi.mocked(listAllEnquiries).mockReset();
  __resetStore();
});

describe('Story 4 — inbox view', () => {
  // AC-5
  it('shows an empty-state message when no enquiries match the filters', async () => {
    vi.mocked(listAllEnquiries).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 5,
    });
    render(<Inbox />);
    expect(
      await screen.findByText(/no enquiries match the current filters/i),
    ).toBeInTheDocument();
  });
});

describe('Story 4 — filter / sort / pagination (data layer)', () => {
  // AC-1
  it('lists all enquiries (unscoped) from every visitor', () => {
    const result = listAll({ pageSize: 100 });
    const owners = new Set(result.items.map((e) => e.submittedByEmail));
    expect(result.total).toBe(6);
    expect(owners.size).toBeGreaterThan(1); // more than one visitor represented
  });

  // AC-2
  it('filters by status and by category, and clearing restores the full list', () => {
    const newOnly = listAll({ status: 'New', pageSize: 100 });
    expect(newOnly.items.every((e) => e.status === 'New')).toBe(true);
    expect(newOnly.total).toBeGreaterThan(0);
    expect(newOnly.total).toBeLessThan(6);

    const feedback = listAll({ category: 'Feedback', pageSize: 100 });
    expect(feedback.items.every((e) => e.category === 'Feedback')).toBe(true);

    const all = listAll({ pageSize: 100 });
    expect(all.total).toBe(6);
  });

  // AC-3
  it('sorts by submitter name and paginates', () => {
    const asc = listAll({ sortBy: 'name', sortDir: 'asc', pageSize: 100 });
    const names = asc.items.map((e) => e.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);

    const page1 = listAll({ page: 1, pageSize: 5 });
    const page2 = listAll({ page: 2, pageSize: 5 });
    expect(page1.items).toHaveLength(5);
    expect(page2.items).toHaveLength(1);
    const ids = new Set(page1.items.map((e) => e.id));
    expect(page2.items.some((e) => ids.has(e.id))).toBe(false);
  });
});
