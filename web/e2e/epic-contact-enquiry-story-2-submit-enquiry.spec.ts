/**
 * Epic contact-enquiry, Story 2 — Submit an enquiry.
 *
 * Mocking strategy: No network backend. Server behaviour is simulated
 * client-side by an in-memory store; the spec drives the real UI. No route
 * interception needed.
 */
import { test, expect } from '@playwright/test';
import { visitorUser, agentUser } from './fixtures/users';

async function signInAs(
  page: import('@playwright/test').Page,
  user: { email: string; password: string },
) {
  await page.goto('/');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('Story 2: Submit an enquiry', () => {
  test('a Visitor submits the form and sees a confirmation, then the form is cleared', async ({
    page,
  }) => {
    await signInAs(page, visitorUser);
    await expect(page).toHaveURL('/contact');

    await page.getByLabel('Name *').fill('Val Visitor');
    await page.getByLabel('Email *').fill('visitor@example.com');
    await page.getByLabel('Address').fill('1 Test Street');

    await page.getByLabel('Category').click();
    await page.getByRole('option', { name: 'Feedback' }).click();

    await page.getByLabel('Comment *').fill('Great service, thank you!');
    await page.getByRole('button', { name: 'Send message' }).click();

    const confirmation = page.getByRole('status');
    await expect(confirmation).toContainText('Message sent!');
    await expect(confirmation).toContainText('Great service, thank you!');
    await expect(confirmation).toContainText('Feedback');

    // Form cleared for another submission
    await expect(page.getByLabel('Name *')).toHaveValue('');
    await expect(page.getByLabel('Comment *')).toHaveValue('');
  });

  // AC-4
  test('a Support Agent opening /contact sees a permission-denied banner, not the form', async ({
    page,
  }) => {
    await signInAs(page, agentUser);
    await expect(page).toHaveURL('/inbox');

    await page.goto('/contact');
    await expect(page.getByRole('alert')).toContainText(
      /don.?t have permission/i,
    );
    await expect(
      page.getByRole('button', { name: 'Send message' }),
    ).toHaveCount(0);
  });
});
