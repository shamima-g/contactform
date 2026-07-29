/**
 * Epic contact-enquiry, Story 3 — My submissions.
 *
 * Mocking strategy: No network backend. Server behaviour is simulated
 * client-side by an in-memory store seeded on load; the spec drives the real
 * UI. No route interception needed.
 */
import { test, expect } from '@playwright/test';
import { visitorUser, adminUser } from './fixtures/users';

async function signInAs(
  page: import('@playwright/test').Page,
  user: { email: string; password: string },
) {
  await page.goto('/');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('Story 3: My submissions', () => {
  test('a Visitor sees their own submissions with statuses', async ({
    page,
  }) => {
    await signInAs(page, visitorUser);
    await page.getByRole('link', { name: /my submissions/i }).click();

    await expect(page).toHaveURL('/my-submissions');
    await expect(
      page.getByRole('heading', { name: /my submissions/i }),
    ).toBeVisible();
    // Seeded: this visitor owns at least one enquiry.
    await expect(
      page.getByText(/opening hours over the holidays/i),
    ).toBeVisible();
  });

  test('a newly submitted enquiry appears in My submissions', async ({
    page,
  }) => {
    await signInAs(page, visitorUser);
    await expect(page).toHaveURL('/contact');

    await page.getByLabel('Name *').fill('Val Visitor');
    await page.getByLabel('Email *').fill('visitor@example.com');
    await page
      .getByLabel('Comment *')
      .fill('A brand new enquiry from the test');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByRole('status')).toContainText('Message sent!');

    await page.getByRole('link', { name: /my submissions/i }).click();
    await expect(
      page.getByText('A brand new enquiry from the test'),
    ).toBeVisible();
  });

  // AC-4
  test('an Admin opening /my-submissions sees a permission-denied banner', async ({
    page,
  }) => {
    await signInAs(page, adminUser);
    await page.goto('/my-submissions');
    await expect(page.getByRole('alert')).toContainText(
      /don.?t have permission/i,
    );
  });
});
