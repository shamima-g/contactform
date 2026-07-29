/**
 * Story 1 — Sign in. Covers the sign-in form's own behaviour (jsdom-observable):
 * a wrong password surfaces an inline error, and valid credentials navigate to
 * the role home. The full signed-out/deep-link/back-button routing is covered
 * by the Playwright spec.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthError } from '@/lib/api/auth';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api/auth', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/api/auth')>('@/lib/api/auth');
  return { ...actual, signIn: vi.fn() };
});

import { signIn as mockSignIn } from '@/lib/api/auth';
import { SessionProvider } from '@/lib/auth/session';
import { SignInForm } from '@/components/sign-in-form';

function renderForm() {
  return render(
    <SessionProvider>
      <SignInForm />
    </SessionProvider>,
  );
}

beforeEach(() => {
  replace.mockClear();
  vi.mocked(mockSignIn).mockReset();
  window.localStorage.clear();
});

describe('Story 1 — sign-in form', () => {
  // AC-2
  it('shows an inline error and stays on sign-in when the password is wrong', async () => {
    vi.mocked(mockSignIn).mockRejectedValue(new AuthError('bad'));
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText(/email/i), 'visitor@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /incorrect email or password/i,
    );
    expect(replace).not.toHaveBeenCalled();
  });

  // AC-1 (form success handling; full redirect flow verified in Playwright)
  it('navigates to the role home on valid credentials', async () => {
    vi.mocked(mockSignIn).mockResolvedValue({
      email: 'visitor@example.com',
      role: 'Visitor',
      name: 'Val Visitor',
    });
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText(/email/i), 'visitor@example.com');
    await user.type(screen.getByLabelText(/password/i), 'Test123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/contact'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
