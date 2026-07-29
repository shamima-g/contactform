/**
 * Story 5 — Triage status lifecycle. Covers the "no actions once Resolved"
 * rule in the inbox (jsdom) and the lifecycle rules in the data layer:
 * transitions follow New → In Progress → Resolved, and resolving requires a
 * non-empty reply note. The full click-through (start progress, resolve with a
 * note, empty-note rejected) is covered by the Playwright spec.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('@/lib/api/enquiries', () => ({
  listAllEnquiries: vi.fn(),
  updateEnquiryStatus: vi.fn(),
}));

import { listAllEnquiries } from '@/lib/api/enquiries';
import { Inbox } from '@/components/inbox';
import { advanceStatus, create, __resetStore } from '@/lib/data/store';

beforeEach(() => {
  vi.mocked(listAllEnquiries).mockReset();
  __resetStore();
});

describe('Story 5 — inbox status actions', () => {
  // AC-4
  it('offers no status actions on a Resolved enquiry', async () => {
    vi.mocked(listAllEnquiries).mockResolvedValue({
      items: [
        {
          id: 'r1',
          name: 'Marcus Lee',
          email: 'marcus@example.com',
          address: null,
          category: 'Feedback',
          comment: 'Resolved item',
          status: 'Resolved',
          replyNote: 'Handled.',
          submittedByEmail: 'marcus@example.com',
          createdAt: '2026-07-18T16:00:00.000Z',
          updatedAt: '2026-07-19T10:30:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 5,
    });

    render(<Inbox />);
    const row = (await screen.findByText('Marcus Lee')).closest('tr')!;
    expect(
      within(row).queryByRole('button', { name: /start progress/i }),
    ).toBeNull();
    expect(within(row).queryByRole('button', { name: /resolve/i })).toBeNull();
    expect(within(row).getByText('Resolved')).toBeInTheDocument();
  });
});

describe('Story 5 — status lifecycle (data layer)', () => {
  // AC-1
  it('advances New → In Progress', () => {
    const enquiry = create(
      { name: 'T', email: 't@example.com', category: 'Question', comment: 'c' },
      't@example.com',
    );
    const updated = advanceStatus(enquiry.id, 'In Progress');
    expect(updated.status).toBe('In Progress');
  });

  // AC-2 — resolve requires a non-empty note; illegal jumps rejected
  it('rejects resolving without a note and rejects skipping a step', () => {
    const enquiry = create(
      { name: 'T', email: 't@example.com', category: 'Question', comment: 'c' },
      't@example.com',
    );
    // Cannot jump New → Resolved
    expect(() => advanceStatus(enquiry.id, 'Resolved', 'note')).toThrow();

    advanceStatus(enquiry.id, 'In Progress');
    // Empty note is rejected
    expect(() => advanceStatus(enquiry.id, 'Resolved', '   ')).toThrow(
      /reply note/i,
    );
  });

  // AC-3
  it('resolves with a non-empty note and stores it', () => {
    const enquiry = create(
      { name: 'T', email: 't@example.com', category: 'Question', comment: 'c' },
      't@example.com',
    );
    advanceStatus(enquiry.id, 'In Progress');
    const resolved = advanceStatus(enquiry.id, 'Resolved', 'Sorted it out');
    expect(resolved.status).toBe('Resolved');
    expect(resolved.replyNote).toBe('Sorted it out');
  });
});
