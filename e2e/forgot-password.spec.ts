import { test, expect } from '@playwright/test';

test('Forgot password link is visible and points to WhatsApp', async ({ page }) => {
  await page.goto('/');
  const link = page.locator('#forgotPasswordBtn');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', /wa\.me/);
  await expect(link).toContainText('Forgot password');
});
