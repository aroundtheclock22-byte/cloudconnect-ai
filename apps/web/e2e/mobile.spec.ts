import { expect, test } from '@playwright/test';

test('mobile layout: navigation drawer and no horizontal scroll', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Work email').fill('demo@cloudconnect.ai');
  await page.getByLabel('Password').fill('DemoPassw0rd!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
  await page.getByLabel('Toggle navigation').click();
  await page.getByRole('link', { name: 'Voicemail' }).click();
  await expect(page.getByText('Visual voicemail')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
