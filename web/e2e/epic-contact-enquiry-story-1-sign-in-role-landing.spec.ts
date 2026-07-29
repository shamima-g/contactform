/**
 * Epic contact-enquiry, Story 1 — Sign in & role-based landing.
 *
 * Mocking strategy: No network backend. The app's server behaviour is simulated
 * client-side by an in-memory store seeded on load; auth validates against the
 * seeded users. No route interception is needed — the specs drive the real
 * sign-in UI. State resets on a full page load.
 */
import { test, expect } from '@playwright/test';
import { visitorUser, agentUser, adminUser } from './fixtures/users';

async function signIn(
  page: import('@playwright/test').Page,
  user: { email: string; password: string },
) {
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('Story 1: Sign in & role-based landing', () => {
  // AC-3: root is gated while signed out
  test('signed-out visit to the root shows the sign-in screen, not a welcome page', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(
      page.getByText('Replace this with your feature implementation.'),
    ).toHaveCount(0);
  });

  // AC-3: deep link is gated while signed out
  test('signed-out deep link to a protected route lands on sign-in', async ({
    page,
  }) => {
    await page.goto('/inbox');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page).toHaveURL('/');
  });

  // AC-1: role-based landing
  test('a Visitor lands on the contact form', async ({ page }) => {
    await page.goto('/');
    await signIn(page, visitorUser);
    await expect(page).toHaveURL('/contact');
    await expect(
      page.getByRole('heading', { name: /contact us/i }),
    ).toBeVisible();
  });

  test('a Support Agent lands on the inbox', async ({ page }) => {
    await page.goto('/');
    await signIn(page, agentUser);
    await expect(page).toHaveURL('/inbox');
    await expect(page.getByRole('heading', { name: /inbox/i })).toBeVisible();
  });

  test('an Admin lands on the inbox', async ({ page }) => {
    await page.goto('/');
    await signIn(page, adminUser);
    await expect(page).toHaveURL('/inbox');
    await expect(page.getByRole('heading', { name: /inbox/i })).toBeVisible();
  });

  // AC-5: out-of-role deep link shows the permission-denied banner (not the content)
  test('a Visitor opening the inbox sees a permission-denied banner', async ({
    page,
  }) => {
    await page.goto('/');
    await signIn(page, visitorUser);
    await expect(page).toHaveURL('/contact');
    await page.goto('/inbox');
    await expect(page.getByRole('alert')).toContainText(
      /don.?t have permission/i,
    );
    await expect(page.getByRole('table')).toHaveCount(0);
  });

  // AC-4: back button after sign-out is gated
  test('after signing out, the browser Back button does not reveal the protected page', async ({
    page,
  }) => {
    await page.goto('/');
    await signIn(page, agentUser);
    await expect(page).toHaveURL('/inbox');

    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
  });
});
