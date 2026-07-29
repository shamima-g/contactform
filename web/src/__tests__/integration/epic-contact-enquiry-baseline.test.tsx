/**
 * Per-epic baseline — cross-story invariants for the Contact & Enquiry epic:
 * the app shell's role-aware navigation and sign-out, and the route guard's
 * permission-denied behaviour. Later stories in this epic do not re-assert
 * these; their test files cover only their own delta.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionUser } from '@/types/domain';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/inbox',
  useSearchParams: () => new URLSearchParams(),
}));

const signOut = vi.fn();
let currentUser: SessionUser | null | undefined;
vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({ user: currentUser, signIn: vi.fn(), signOut }),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { AppShell } from '@/components/app-shell';
import { RouteGuard } from '@/components/route-guard';

const AGENT: SessionUser = {
  email: 'agent@example.com',
  role: 'Support Agent',
  name: 'Sam Agent',
};
const VISITOR: SessionUser = {
  email: 'visitor@example.com',
  role: 'Visitor',
  name: 'Val Visitor',
};

beforeEach(() => {
  replace.mockClear();
  signOut.mockClear();
  currentUser = undefined;
});

describe('Epic baseline — app shell', () => {
  // AC-6
  it('shows the signed-in user, their role, and a working Sign out control', async () => {
    const user = userEvent.setup();
    render(
      <AppShell user={AGENT}>
        <p>inbox content</p>
      </AppShell>,
    );

    expect(screen.getByText('Sam Agent')).toBeInTheDocument();
    expect(screen.getByText('Support Agent')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /sign out/i }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/');
  });

  // AC-6
  it('renders role-appropriate navigation for each role', () => {
    const { rerender } = render(
      <AppShell user={VISITOR}>
        <p>content</p>
      </AppShell>,
    );
    const visitorNav = screen.getByRole('navigation', { name: /primary/i });
    expect(
      within(visitorNav).getByRole('link', { name: /contact us/i }),
    ).toBeInTheDocument();
    expect(
      within(visitorNav).getByRole('link', { name: /my submissions/i }),
    ).toBeInTheDocument();
    expect(
      within(visitorNav).queryByRole('link', { name: /inbox/i }),
    ).not.toBeInTheDocument();

    rerender(
      <AppShell user={AGENT}>
        <p>content</p>
      </AppShell>,
    );
    const agentNav = screen.getByRole('navigation', { name: /primary/i });
    expect(
      within(agentNav).getByRole('link', { name: /inbox/i }),
    ).toBeInTheDocument();
    expect(
      within(agentNav).queryByRole('link', { name: /contact us/i }),
    ).not.toBeInTheDocument();
  });
});

describe('Epic baseline — route guard', () => {
  it('renders the page for an allowed role', () => {
    currentUser = AGENT;
    render(
      <RouteGuard allow={['Support Agent', 'Admin']}>
        <p>inbox content</p>
      </RouteGuard>,
    );
    expect(screen.getByText('inbox content')).toBeInTheDocument();
  });

  it('shows a permission-denied banner and hides content for a disallowed role', () => {
    currentUser = VISITOR;
    render(
      <RouteGuard allow={['Support Agent', 'Admin']}>
        <p>inbox content</p>
      </RouteGuard>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      /don.?t have permission/i,
    );
    expect(screen.queryByText('inbox content')).not.toBeInTheDocument();
  });

  it('while signed out, hides content and redirects to sign-in', () => {
    currentUser = null;
    render(
      <RouteGuard allow={['Support Agent', 'Admin']}>
        <p>inbox content</p>
      </RouteGuard>,
    );
    expect(screen.queryByText('inbox content')).not.toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith('/');
  });
});
