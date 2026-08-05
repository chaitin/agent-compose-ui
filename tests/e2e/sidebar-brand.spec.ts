import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1600, height: 900 } });

test('shows the approved image and product name in the sidebar', async ({ page }) => {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: {
        enabled: false,
        loggedIn: false,
        oauthEnabled: false,
        username: '',
        expiresAt: '',
      },
    }),
  );

  await page.goto('/');

  const sidebar = page.locator('aside').first();
  const logo = sidebar.locator('img[alt="Agent-Compose"]');
  await expect(sidebar.getByText('Agent-Compose', { exact: true })).toBeVisible();
  await expect(logo).toBeVisible();
  await expect(logo).toHaveCSS('width', '41.25px');
  await expect(logo).toHaveCSS('height', '30px');
});

test('shows the approved lockup at the reference-aligned size on the login page', async ({ page }) => {
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        loggedIn: false,
        oauthEnabled: false,
        username: '',
        expiresAt: '',
      },
    }),
  );

  await page.goto('/');

  const logo = page.locator('main img[alt="Agent-Compose"]');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveCSS('height', '41.25px');
  await expect(page.getByRole('heading', { name: 'Agent-Compose', exact: true })).toBeVisible();
  await expect(page.getByText('登录 Web 控制台', { exact: true })).toBeVisible();
});
