import { expect, test } from '@playwright/test';
import { apiGet, waitForIndexer } from '../helpers';

test.describe('Discovery', () => {
  test.beforeAll(async () => { await waitForIndexer(); });

  test('US-18: the market shows the seeded listings with their live risk', async ({ page }) => {
    await page.goto('/#/market');
    await expect(page.getByRole('heading', { name: 'Open listings' })).toBeVisible();

    const cards = page.locator('a.card');
    await expect(cards).toHaveCount(2);

    // Every card carries price, health factor and the collateral to debt route.
    await expect(page.getByText('5,500 USDC')).toBeVisible();
    await expect(page.locator('.tag--quick')).toBeVisible();
    await expect(page.locator('.risk__track').first()).toBeVisible();
    await expect(page.getByText(/Block \d+/)).toBeVisible();
  });

  test('US-19: filtering by asset and by health factor narrows the list', async ({ page }) => {
    await page.goto('/#/market');
    await expect(page.locator('a.card')).toHaveCount(2);

    await page.locator('#f-asset').selectOption('LINK');
    await expect(page.locator('a.card')).toHaveCount(0);

    await page.locator('#f-asset').selectOption('');
    await page.locator('#f-hf').fill('2.00');
    // Only the healthy listing survives a 2.0 floor.
    await expect(page.locator('a.card')).toHaveCount(1);
    await expect(page.getByText('5,500 USDC')).toBeVisible();
  });

  test('US-20: the detail page explains the risk of one listing', async ({ page }) => {
    await page.goto('/#/listing/3');
    await expect(page.getByRole('heading', { name: 'Listing #3' })).toBeVisible();
    await expect(page.getByText('80.0% of net value')).toBeVisible();
    await expect(page.getByText('Estimated liquidation price (WETH)')).toBeVisible();
    await expect(page.getByText('Liquidation threshold')).toBeVisible();
    await expect(page.getByText('Seller health factor threshold')).toBeVisible();
  });

  test('US-29: the same listings are available to a program', async () => {
    const body = await apiGet<{ total: number; items: Array<{ tokenId: string; status: string; currentPrice: string }> }>(
      '/api/listings?status=active',
    );
    expect(body.total).toBe(2);
    for (const item of body.items) {
      expect(item.status).toBe('active');
      expect(BigInt(item.currentPrice)).toBeGreaterThan(0n);
    }

    const filtered = await apiGet<{ total: number }>('/api/listings?quickSale=true');
    expect(filtered.total).toBe(1);
  });
});
