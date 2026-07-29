/**
 * Enquiry entity factory + canonical seed dataset.
 *
 * `createEnquiry(overrides)` is the single source of truth for an enquiry's
 * shape and defaults. `seedEnquiries()` returns a fresh copy of the seed set
 * used to prime the in-memory store and both test layers.
 *
 * Import rules (testing-policy § Mock data): types via `import type` only.
 */
import type { Enquiry } from '@/types/domain';

let seq = 0;
function nextId(): string {
  seq += 1;
  return `enq_${String(seq).padStart(3, '0')}`;
}

export function createEnquiry(overrides: Partial<Enquiry> = {}): Enquiry {
  const createdAt = overrides.createdAt ?? '2026-07-20T09:00:00.000Z';
  return {
    id: overrides.id ?? nextId(),
    name: 'Val Visitor',
    email: 'visitor@example.com',
    address: null,
    category: 'Question',
    comment: 'I have a question about your opening hours.',
    status: 'New',
    replyNote: null,
    submittedByEmail: 'visitor@example.com',
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    ...overrides,
  };
}

/**
 * A fresh copy of the seed dataset. Spans all three categories and all three
 * statuses; at least two are owned by visitor@example.com so the Visitor's
 * "My submissions" view is non-empty. ≥2 items per status/category so filters
 * visibly narrow the inbox.
 */
export function seedEnquiries(): Enquiry[] {
  seq = 0;
  return [
    createEnquiry({
      id: 'enq_001',
      name: 'Val Visitor',
      email: 'visitor@example.com',
      submittedByEmail: 'visitor@example.com',
      category: 'Question',
      comment: 'What are your opening hours over the holidays?',
      status: 'New',
      createdAt: '2026-07-21T08:15:00.000Z',
      updatedAt: '2026-07-21T08:15:00.000Z',
    }),
    createEnquiry({
      id: 'enq_002',
      name: 'Val Visitor',
      email: 'visitor@example.com',
      submittedByEmail: 'visitor@example.com',
      address: '12 Oak Lane, Springfield',
      category: 'Feedback',
      comment: 'Loved the new checkout flow — much faster.',
      status: 'In Progress',
      createdAt: '2026-07-20T14:40:00.000Z',
      updatedAt: '2026-07-22T09:05:00.000Z',
    }),
    createEnquiry({
      id: 'enq_003',
      name: 'Priya Menon',
      email: 'priya@example.com',
      submittedByEmail: 'priya@example.com',
      category: 'General Enquiry',
      comment: 'Do you ship internationally?',
      status: 'New',
      createdAt: '2026-07-22T11:20:00.000Z',
      updatedAt: '2026-07-22T11:20:00.000Z',
    }),
    createEnquiry({
      id: 'enq_004',
      name: 'Marcus Lee',
      email: 'marcus@example.com',
      submittedByEmail: 'marcus@example.com',
      category: 'Feedback',
      comment: 'The mobile menu is hard to tap on small screens.',
      status: 'Resolved',
      replyNote:
        'Thanks — we have enlarged the tap targets in the latest release.',
      createdAt: '2026-07-18T16:00:00.000Z',
      updatedAt: '2026-07-19T10:30:00.000Z',
    }),
    createEnquiry({
      id: 'enq_005',
      name: 'Dana White',
      email: 'dana@example.com',
      submittedByEmail: 'dana@example.com',
      category: 'Question',
      comment: 'Can I change my delivery address after ordering?',
      status: 'In Progress',
      createdAt: '2026-07-23T07:50:00.000Z',
      updatedAt: '2026-07-23T13:10:00.000Z',
    }),
    createEnquiry({
      id: 'enq_006',
      name: 'Omar Haddad',
      email: 'omar@example.com',
      submittedByEmail: 'omar@example.com',
      category: 'General Enquiry',
      comment: 'Are you hiring for support roles?',
      status: 'Resolved',
      replyNote: 'We are — see our careers page for current openings.',
      createdAt: '2026-07-17T09:25:00.000Z',
      updatedAt: '2026-07-18T08:00:00.000Z',
    }),
  ];
}
