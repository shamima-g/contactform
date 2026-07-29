/**
 * Epic contact-enquiry, Story 4 — Back-office inbox.
 *
 * Mocking strategy: No network backend. Server behaviour is simulated
 * client-side by an in-memory store seeded on load; the spec drives the real
 * UI. No route interception needed. Also hosts the epic's accessibility scan
 * for the primary data surface.
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { agentUser, visitorUser } from './fixtures/users';

async function signInAs(
  page: import('@playwright/test').Page,
  user: { email: string; password: string },
) {
  await page.goto('/');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function dataRowCount(page: import('@playwright/test').Page) {
  return page.getByRole('rowgroup').last().getByRole('row').count();
}

test.describe('Story 4: Back-office inbox', () => {
  test('lists enquiries from multiple visitors', async ({ page }) => {
    await signInAs(page, agentUser);
    await expect(page).toHaveURL('/inbox');
    await expect(
      page.getByRole('cell', { name: 'Val Visitor' }).first(),
    ).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Priya Menon' })).toBeVisible();
    await expect(page.getByText(/enquir(y|ies) · page 1 of 2/)).toBeVisible();
  });

  test('filtering by status narrows the list and clearing restores it', async ({
    page,
  }) => {
    await signInAs(page, agentUser);
    await page.getByLabel('Filter by status').click();
    await page.getByRole('option', { name: 'New' }).click();

    await expect(page.getByRole('cell', { name: 'Priya Menon' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Marcus Lee' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByText(/6 enquiries/)).toBeVisible();
  });

  test('filtering by category narrows the list', async ({ page }) => {
    await signInAs(page, agentUser);
    await page.getByLabel('Filter by category').click();
    await page.getByRole('option', { name: 'Feedback' }).click();

    const rows = await dataRowCount(page);
    expect(rows).toBeGreaterThan(0);
    for (const cell of await page
      .getByRole('row')
      .getByText('Feedback')
      .all()) {
      await expect(cell).toBeVisible();
    }
    await expect(page.getByRole('cell', { name: 'Priya Menon' })).toHaveCount(
      0,
    );
  });

  test('sorting and paging work', async ({ page }) => {
    await signInAs(page, agentUser);

    // Sort by submitter
    await page.getByRole('button', { name: /submitter/i }).click();
    await expect(
      page.getByRole('columnheader', { name: /submitter/i }),
    ).toHaveAttribute('aria-sort', 'ascending');

    // Paginate
    await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText(/page 2 of 2/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  // AC-4
  test('a Visitor opening /inbox sees a permission-denied banner, not the table', async ({
    page,
  }) => {
    await signInAs(page, visitorUser);
    await page.goto('/inbox');
    await expect(page.getByRole('alert')).toContainText(
      /don.?t have permission/i,
    );
    await expect(page.getByRole('table')).toHaveCount(0);
  });

  test('the inbox has no critical accessibility violations', async ({
    page,
  }) => {
    await signInAs(page, agentUser);
    await expect(page.getByRole('table')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
