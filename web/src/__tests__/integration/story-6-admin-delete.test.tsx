/**
 * Story 6 — Admin delete. Covers the role-gating of the Delete action (Admin
 * sees it, Support Agent never does), the confirm dialog's cancel path (nothing
 * is deleted), and the data-layer removal. The full click-through delete is
 * covered by the Playwright spec.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionUser } from '@/types/domain';

let currentUser: SessionUser;
vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({ user: currentUser, signIn: vi.fn(), signOut: vi.fn() }),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/lib/api/enquiries', () => ({
  listAllEnquiries: vi.fn(),
  updateEnquiryStatus: vi.fn(),
  deleteEnquiry: vi.fn(),
}));

import { listAllEnquiries } from '@/lib/api/enquiries';
import { Inbox } from '@/components/inbox';
import { DeleteConfirmDialog } from '@/components/delete-confirm-dialog';
import { listAll, remove, __resetStore } from '@/lib/data/store';

const ADMIN: SessionUser = {
  email: 'admin@example.com',
  role: 'Admin',
  name: 'Ada Admin',
};
const AGENT: SessionUser = {
  email: 'agent@example.com',
  role: 'Support Agent',
  name: 'Sam Agent',
};

beforeEach(() => {
  __resetStore();
  vi.mocked(listAllEnquiries).mockResolvedValue({
    items: [
      {
        id: 'd1',
        name: 'Priya Menon',
        email: 'priya@example.com',
        address: null,
        category: 'General Enquiry',
        comment: 'Ship internationally?',
        status: 'New',
        replyNote: null,
        submittedByEmail: 'priya@example.com',
        createdAt: '2026-07-22T11:20:00.000Z',
        updatedAt: '2026-07-22T11:20:00.000Z',
      },
    ],
    total: 1,
    page: 1,
    pageSize: 5,
  });
});

describe('Story 6 — delete action role-gating', () => {
  // AC-1
  it('shows a Delete action to an Admin', async () => {
    currentUser = ADMIN;
    render(<Inbox />);
    await screen.findByText('Priya Menon');
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  // AC-4
  it('never shows a Delete action to a Support Agent', async () => {
    currentUser = AGENT;
    render(<Inbox />);
    await screen.findByText('Priya Menon');
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });
});

describe('Story 6 — confirm dialog', () => {
  // AC-3
  it('does not delete when the confirmation is cancelled', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <DeleteConfirmDialog
        enquiry={null}
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('Story 6 — deletion (data layer)', () => {
  // AC-2
  it('removes an enquiry from the dataset', () => {
    const before = listAll({ pageSize: 100 }).total;
    const target = listAll({ pageSize: 100 }).items[0];
    remove(target.id);
    const after = listAll({ pageSize: 100 });
    expect(after.total).toBe(before - 1);
    expect(after.items.some((e) => e.id === target.id)).toBe(false);
  });
});
