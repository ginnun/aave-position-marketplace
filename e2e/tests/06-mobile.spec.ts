import { devices, expect, test } from '@playwright/test';

test.use({ ...devices['Pixel 7'] });

test('the interface works on a phone screen', async ({ page }) => {
  await page.goto('/#/market');
  await expect(page.getByRole('heading', { name: 'Open listings' })).toBeVisible();

  // Nothing may push the page sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  await page.getByRole('link', { name: 'My positions', exact: true }).click();
  await expect(page).toHaveURL(/#\/positions/);

  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});
