import { expect, Page, test } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill('demo@cloudconnect.ai');
  await page.getByLabel('Password').fill('DemoPassw0rd!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
}

test('rejects bad credentials', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Work email').fill('demo@cloudconnect.ai');
  await page.getByLabel('Password').fill('nope-nope-nope');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Invalid email or password');
});

test('dashboard shows live widgets', async ({ page }) => {
  await login(page);
  await expect(page.getByText('Active calls')).toBeVisible();
  await expect(page.getByText('Top agents (7 days)')).toBeVisible();
  await expect(page.getByText('AI insights (7 days)')).toBeVisible();
});

test('session survives reload via refresh cookie', async ({ page }) => {
  await login(page);
  await page.reload();
  await expect(page.getByText('Active calls')).toBeVisible();
});

test('call history with AI insights', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Calls' }).click();
  await page.locator('tbody tr').first().click();
  await expect(page.getByText('Call details')).toBeVisible();
});

test('softphone places a call and shows in-call controls', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Dial' }).click();
  await page.getByLabel('Number to dial').fill('+14155551234');
  await page.getByRole('button', { name: 'Call', exact: true }).click();
  await expect(page.getByText('(415) 555-1234')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hold' })).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: 'Hold' }).click();
  await expect(page.getByText('On hold')).toBeVisible();
  await page.getByRole('button', { name: 'End call' }).click();
});

test('SMS thread and AI suggestions', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Messages' }).click();
  await page.getByText('Olivia Park').click();
  await page.getByLabel('AI reply suggestions').click();
  await expect(page.locator('button.rounded-full').first()).toBeVisible();
  await page.getByLabel('Message').fill('Thanks Olivia — e2e test');
  await page.getByLabel('Send').click();
  await expect(page.getByRole('paragraph').filter({ hasText: 'Thanks Olivia — e2e test' }).first()).toBeVisible();
});

test('IVR simulator walks the published flow', async ({ page }) => {
  await login(page);
  await page.goto('/admin/routing');
  await expect(page.getByText('Flow is valid')).toBeVisible();
  // Weekday 15:00 New York → business hours → language menu
  await page.getByLabel('Call time').fill('2026-11-04T15:00');
  await page.getByRole('button', { name: 'Simulate inbound call' }).click();
  await expect(page.getByText('For English, press 1').last()).toBeVisible();
});

test('contacts search and directory', async ({ page }) => {
  await login(page);
  await page.goto('/contacts');
  await page.getByLabel('Search contacts').fill('Olivia');
  await expect(page.getByRole('cell', { name: /Olivia Park/ })).toBeVisible();
  await page.getByLabel('Search contacts').fill('');
  await page.getByRole('button', { name: 'Company directory' }).click();
  await expect(page.getByText('Ext. 104')).toBeVisible();
});

test('admin pages render', async ({ page }) => {
  await login(page);
  for (const [path, text] of [['/admin/users', 'Users & teams'], ['/admin/numbers', 'Phone numbers'], ['/admin/billing', 'Current period'], ['/admin/security', 'Audit log'], ['/admin/integrations', 'Webhooks'], ['/analytics', 'Geographic report'], ['/voicemail', 'Visual voicemail'], ['/meetings', 'Weekly sales sync']]) {
    await page.goto(path);
    await expect(page.getByText(text).first()).toBeVisible();
  }
});
