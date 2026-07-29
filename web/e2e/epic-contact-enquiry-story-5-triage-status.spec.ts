/**
 * Epic contact-enquiry, Story 5 — Triage status lifecycle.
 *
 * Mocking strategy: No network backend. Server behaviour is simulated
 * client-side by an in-memory store seeded on load; the spec drives the real
 * UI. No route interception needed. State resets on a full page load, so each
 * test starts from the seed dataset.
 */
import { test, expect } from '@playwright/test';
import { agentUser } from './fixtures/users';

async function signInAsAgent(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(agentUser.email);
  await page.getByLabel('Password').fill(agentUser.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/inbox');
}

/** The row containing a given submitter name. */
function rowFor(page: import('@playwright/test').Page, name: string) {
  return page.getByRole('row').filter({ hasText: name });
}

test.describe('Story 5: Triage status lifecycle', () => {
  // AC-1
  test('moves a New enquiry to In Progress via Start progress', async ({
    page,
  }) => {
    await signInAsAgent(page);
    // Priya's enquiry is seeded as New.
    const row = rowFor(page, 'Priya Menon');
    await row.getByRole('button', { name: 'Start progress' }).click();
    await expect(row.getByText('In Progress')).toBeVisible();
  });

  // AC-2: empty note rejected
  test('resolving requires a non-empty reply note', async ({ page }) => {
    await signInAsAgent(page);
    // Dana's enquiry is seeded as In Progress.
    const row = rowFor(page, 'Dana White');
    await row.getByRole('button', { name: 'Resolve' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Resolve' }).click();
    await expect(dialog).toContainText(/reply note is required/i);

    // Still In Progress after closing.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(
      rowFor(page, 'Dana White').getByText('In Progress'),
    ).toBeVisible();
  });

  // AC-3: resolve with a note
  test('resolving with a reply note moves the enquiry to Resolved', async ({
    page,
  }) => {
    await signInAsAgent(page);
    const row = rowFor(page, 'Dana White');
    await row.getByRole('button', { name: 'Resolve' }).click();

    const dialog = page.getByRole('dialog');
    await dialog
      .getByLabel('Reply note')
      .fill('You can update it from your account.');
    await dialog.getByRole('button', { name: 'Resolve' }).click();

    await expect(dialog).toBeHidden();
    await expect(
      rowFor(page, 'Dana White').getByText('Resolved'),
    ).toBeVisible();
  });
});
