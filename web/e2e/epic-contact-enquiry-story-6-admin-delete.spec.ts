/**
 * Epic contact-enquiry, Story 6 — Admin delete.
 *
 * Mocking strategy: No network backend. Server behaviour is simulated
 * client-side by an in-memory store seeded on load; the spec drives the real
 * UI. No route interception needed. State resets on a full page load.
 */
import { test, expect } from '@playwright/test';
import { adminUser, agentUser } from './fixtures/users';

async function signInAs(
  page: import('@playwright/test').Page,
  user: { email: string; password: string },
) {
  await page.goto('/');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/inbox');
}

function rowFor(page: import('@playwright/test').Page, name: string) {
  return page.getByRole('row').filter({ hasText: name });
}

test.describe('Story 6: Admin delete', () => {
  // AC-1 & AC-2
  test('an Admin deletes an enquiry behind a confirmation', async ({
    page,
  }) => {
    await signInAs(page, adminUser);
    await expect(rowFor(page, 'Priya Menon')).toBeVisible();

    await rowFor(page, 'Priya Menon')
      .getByRole('button', { name: 'Delete' })
      .click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(/delete this enquiry/i);
    await dialog.getByRole('button', { name: 'Delete' }).click();

    await expect(dialog).toBeHidden();
    await expect(rowFor(page, 'Priya Menon')).toHaveCount(0);
  });

  // AC-3
  test('cancelling the confirmation leaves the enquiry in place', async ({
    page,
  }) => {
    await signInAs(page, adminUser);
    await rowFor(page, 'Priya Menon')
      .getByRole('button', { name: 'Delete' })
      .click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await expect(dialog).toBeHidden();
    await expect(rowFor(page, 'Priya Menon')).toBeVisible();
  });

  // AC-4
  test('a Support Agent never sees a Delete action', async ({ page }) => {
    await signInAs(page, agentUser);
    await expect(rowFor(page, 'Priya Menon')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  });
});
