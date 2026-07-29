/**
 * Story 3 — My submissions. Covers the Visitor's own-submissions view (own
 * enquiries with status, empty state) and the ownership scoping in the data
 * layer that guarantees a Visitor never sees another visitor's enquiry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SessionUser } from '@/types/domain';
import { createEnquiry } from '@/mocks/data/enquiry';

const VISITOR: SessionUser = {
  email: 'visitor@example.com',
  role: 'Visitor',
  name: 'Val Visitor',
};

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({ user: VISITOR, signIn: vi.fn(), signOut: vi.fn() }),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/lib/api/enquiries', () => ({ listMyEnquiries: vi.fn() }));

import { listMyEnquiries } from '@/lib/api/enquiries';
import { MySubmissions } from '@/components/my-submissions';
import { listOwn, __resetStore } from '@/lib/data/store';

beforeEach(() => {
  vi.mocked(listMyEnquiries).mockReset();
  __resetStore();
});

describe('Story 3 — my submissions view', () => {
  // AC-1
  it("shows the visitor's own enquiries with category, comment, and status", async () => {
    vi.mocked(listMyEnquiries).mockResolvedValue([
      createEnquiry({
        id: 'e1',
        category: 'Question',
        comment: 'Where is my order?',
        status: 'In Progress',
        submittedByEmail: VISITOR.email,
      }),
    ]);
    render(<MySubmissions />);

    expect(await screen.findByText('Where is my order?')).toBeInTheDocument();
    expect(screen.getByText('Question')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
  });

  // AC-3
  it('shows an empty-state message when the visitor has no submissions', async () => {
    vi.mocked(listMyEnquiries).mockResolvedValue([]);
    render(<MySubmissions />);

    expect(
      await screen.findByText(/haven.?t submitted any enquiries yet/i),
    ).toBeInTheDocument();
  });
});

describe('Story 3 — ownership scoping (data layer)', () => {
  // AC-2 — the guarantee that a Visitor never sees another visitor's enquiry
  it("listOwn returns only the given submitter's enquiries", () => {
    const mine = listOwn('visitor@example.com');
    expect(mine.length).toBeGreaterThan(0);
    expect(
      mine.every((e) => e.submittedByEmail === 'visitor@example.com'),
    ).toBe(true);
    // A different visitor's enquiry (seeded) is not in the result set.
    expect(mine.some((e) => e.submittedByEmail === 'priya@example.com')).toBe(
      false,
    );
  });
});
