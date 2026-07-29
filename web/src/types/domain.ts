/**
 * Domain types for the Contact & Enquiry Management app.
 *
 * There is no real backend — all server behaviour is simulated client-side
 * (see generated-docs/project.md §Data Source). These types are the shared
 * contract used by the in-memory data layer, the API module, the UI, and the
 * test/mock factories.
 */

export const ROLES = ['Visitor', 'Support Agent', 'Admin'] as const;
export type Role = (typeof ROLES)[number];

export const CATEGORIES = ['Feedback', 'Question', 'General Enquiry'] as const;
export type Category = (typeof CATEGORIES)[number];

export const STATUSES = ['New', 'In Progress', 'Resolved'] as const;
export type Status = (typeof STATUSES)[number];

/** The next status in the lifecycle, or null when terminal (Resolved). */
export const NEXT_STATUS: Record<Status, Status | null> = {
  New: 'In Progress',
  'In Progress': 'Resolved',
  Resolved: null,
};

export interface Enquiry {
  id: string;
  name: string;
  email: string;
  address: string | null;
  category: Category;
  comment: string;
  status: Status;
  replyNote: string | null;
  submittedByEmail: string;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  email: string;
  password: string;
  role: Role;
  name: string;
}

/** The signed-in identity the app gates on (no password). */
export interface SessionUser {
  email: string;
  role: Role;
  name: string;
}

export interface NewEnquiryInput {
  name: string;
  email: string;
  address?: string | null;
  category: Category;
  comment: string;
}

export interface EnquiryQuery {
  category?: Category | 'all';
  status?: Status | 'all';
  sortBy?: 'createdAt' | 'name' | 'status';
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
