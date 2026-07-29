/**
 * In-memory enquiry store — the simulated server.
 *
 * There is no backend (project.md §Data Source). This singleton holds the
 * enquiry dataset for the browser session, seeded on first load. It owns all
 * "server-side" logic: ownership scoping, filtering, sorting, pagination, and
 * the status lifecycle. The API module (lib/api) is the only caller; UI code
 * never touches this module directly.
 */
import type {
  Category,
  Enquiry,
  EnquiryQuery,
  NewEnquiryInput,
  PagedResult,
  Status,
} from '@/types/domain';
import { NEXT_STATUS } from '@/types/domain';
import { seedEnquiries } from '@/mocks/data/enquiry';

let enquiries: Enquiry[] = seedEnquiries();
let idCounter = enquiries.length;

function now(): string {
  return new Date().toISOString();
}

function genId(): string {
  idCounter += 1;
  return `enq_${String(idCounter).padStart(3, '0')}`;
}

/** Reset to the seed dataset. Test-only helper. */
export function __resetStore(): void {
  enquiries = seedEnquiries();
  idCounter = enquiries.length;
}

/** All enquiries owned by a given submitter, newest first. */
export function listOwn(email: string): Enquiry[] {
  return enquiries
    .filter((e) => e.submittedByEmail.toLowerCase() === email.toLowerCase())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((e) => ({ ...e }));
}

/** Back-office list: all enquiries, with optional filter / sort / pagination. */
export function listAll(query: EnquiryQuery = {}): PagedResult<Enquiry> {
  const {
    category = 'all',
    status = 'all',
    sortBy = 'createdAt',
    sortDir = 'desc',
    page = 1,
    pageSize = 10,
  } = query;

  let rows = enquiries.slice();

  if (category !== 'all') {
    rows = rows.filter((e) => e.category === (category as Category));
  }
  if (status !== 'all') {
    rows = rows.filter((e) => e.status === (status as Status));
  }

  rows.sort((a, b) => {
    let cmp = 0;
    if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
    else if (sortBy === 'status') cmp = a.status.localeCompare(b.status);
    else cmp = a.createdAt.localeCompare(b.createdAt);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const total = rows.length;
  const start = (page - 1) * pageSize;
  const items = rows.slice(start, start + pageSize).map((e) => ({ ...e }));
  return { items, total, page, pageSize };
}

export function getById(id: string): Enquiry | undefined {
  const found = enquiries.find((e) => e.id === id);
  return found ? { ...found } : undefined;
}

export function create(input: NewEnquiryInput, ownerEmail: string): Enquiry {
  const timestamp = now();
  const enquiry: Enquiry = {
    id: genId(),
    name: input.name.trim(),
    email: input.email.trim(),
    address: input.address?.trim() ? input.address.trim() : null,
    category: input.category,
    comment: input.comment.trim(),
    status: 'New',
    replyNote: null,
    submittedByEmail: ownerEmail,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  enquiries = [enquiry, ...enquiries];
  return { ...enquiry };
}

/**
 * Advance an enquiry's status. `New → In Progress` needs no note; `In Progress
 * → Resolved` requires a non-empty reply note. Throws on an illegal transition
 * or a missing note.
 */
export function advanceStatus(
  id: string,
  target: Status,
  replyNote?: string,
): Enquiry {
  const enquiry = enquiries.find((e) => e.id === id);
  if (!enquiry) throw new Error(`Enquiry ${id} not found`);

  if (NEXT_STATUS[enquiry.status] !== target) {
    throw new Error(`Illegal status transition: ${enquiry.status} → ${target}`);
  }
  if (target === 'Resolved') {
    if (!replyNote || replyNote.trim().length === 0) {
      throw new Error('A reply note is required to resolve an enquiry');
    }
    enquiry.replyNote = replyNote.trim();
  }
  enquiry.status = target;
  enquiry.updatedAt = now();
  return { ...enquiry };
}

export function remove(id: string): void {
  const before = enquiries.length;
  enquiries = enquiries.filter((e) => e.id !== id);
  if (enquiries.length === before) {
    throw new Error(`Enquiry ${id} not found`);
  }
}
