/**
 * Enquiry API module — the boundary the UI calls.
 *
 * There is no HTTP backend (project.md §Data Source); these async functions
 * stand in for a REST client, delegating to the in-memory store (the simulated
 * server). UI components import from here and never touch the store directly.
 * Vitest tests mock this module (`vi.mock('@/lib/api/enquiries')`).
 */
import type {
  Enquiry,
  EnquiryQuery,
  NewEnquiryInput,
  PagedResult,
  Status,
} from '@/types/domain';
import * as store from '@/lib/data/store';

/** Small simulated latency so loading states are exercised, kept short for tests. */
const LATENCY_MS = 60;

function simulate<T>(produce: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(produce());
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }, LATENCY_MS);
  });
}

/** Back-office: all enquiries with filter / sort / pagination. */
export function listAllEnquiries(
  query: EnquiryQuery = {},
): Promise<PagedResult<Enquiry>> {
  return simulate(() => store.listAll(query));
}

/** Visitor: only the signed-in submitter's own enquiries. */
export function listMyEnquiries(email: string): Promise<Enquiry[]> {
  return simulate(() => store.listOwn(email));
}

export function createEnquiry(
  input: NewEnquiryInput,
  ownerEmail: string,
): Promise<Enquiry> {
  return simulate(() => store.create(input, ownerEmail));
}

export function updateEnquiryStatus(
  id: string,
  target: Status,
  replyNote?: string,
): Promise<Enquiry> {
  return simulate(() => store.advanceStatus(id, target, replyNote));
}

export function deleteEnquiry(id: string): Promise<void> {
  return simulate(() => store.remove(id));
}
