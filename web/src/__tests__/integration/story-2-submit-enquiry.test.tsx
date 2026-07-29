/**
 * Story 2 — Submit an enquiry. Covers the contact form: field rendering,
 * inline validation, and the success path (confirmation + cleared form). The
 * non-Visitor permission-denied gate is covered by the Playwright spec.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionUser } from '@/types/domain';
import { createEnquiry as createEnquiryImpl } from '@/mocks/data/enquiry';

const VISITOR: SessionUser = {
  email: 'visitor@example.com',
  role: 'Visitor',
  name: 'Val Visitor',
};

vi.mock('@/lib/auth/session', () => ({
  useSession: () => ({ user: VISITOR, signIn: vi.fn(), signOut: vi.fn() }),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/lib/api/enquiries', () => ({ createEnquiry: vi.fn() }));

import { createEnquiry } from '@/lib/api/enquiries';
import { ContactForm } from '@/components/contact-form';

beforeEach(() => {
  vi.mocked(createEnquiry).mockReset();
});

describe('Story 2 — contact form', () => {
  // AC-1
  it('renders the fields specified in the brief', () => {
    render(<ContactForm />);
    expect(screen.getByLabelText(/name \*/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email \*/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^address$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/category/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/comment \*/i)).toBeInTheDocument();
  });

  // AC-2
  it('shows validation messages and does not send when required fields are missing or the email is invalid', async () => {
    const user = userEvent.setup();
    render(<ContactForm />);

    await user.type(screen.getByLabelText(/email \*/i), 'not-an-email');
    await user.type(screen.getByLabelText(/comment \*/i), 'Hello');
    await user.click(screen.getByRole('button', { name: /send message/i }));

    expect(
      await screen.findByText(/please enter your name/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/please enter a valid email address/i),
    ).toBeInTheDocument();
    expect(createEnquiry).not.toHaveBeenCalled();
  });

  // AC-3
  it('on success shows "Message sent!" with a confirmation of what was sent and clears the form', async () => {
    vi.mocked(createEnquiry).mockImplementation(async (input, owner) =>
      createEnquiryImpl({
        ...input,
        address: input.address ?? null,
        submittedByEmail: owner,
      }),
    );
    const user = userEvent.setup();
    render(<ContactForm />);

    await user.type(screen.getByLabelText(/name \*/i), 'Val Visitor');
    await user.type(screen.getByLabelText(/email \*/i), 'visitor@example.com');
    await user.type(
      screen.getByLabelText(/comment \*/i),
      'Do you offer gift cards?',
    );
    await user.click(screen.getByRole('button', { name: /send message/i }));

    const confirmation = await screen.findByRole('status');
    expect(within(confirmation).getByText(/message sent/i)).toBeInTheDocument();
    expect(
      within(confirmation).getByText('Do you offer gift cards?'),
    ).toBeInTheDocument();
    expect(within(confirmation).getByText('Val Visitor')).toBeInTheDocument();

    // Form cleared
    await waitFor(() =>
      expect(screen.getByLabelText(/name \*/i)).toHaveValue(''),
    );
    expect(screen.getByLabelText(/comment \*/i)).toHaveValue('');
  });
});
