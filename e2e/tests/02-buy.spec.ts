import { expect, test } from '@playwright/test';
import { ACCOUNTS, apiGet, connect, expectDone, settled, waitForApi, waitForIndexer } from '../helpers';

test.describe('Buying', () => {
  test('US-22, US-23, US-24, US-25: buy a listed position in one transaction', async ({ page }) => {
    await connect(page, 'Bob');
    await page.goto('/#/listing/2');

    await page.getByRole('button', { name: 'Buy', exact: true }).click();
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await settled(modal, /^(Approve USDC|Confirm purchase)$/);

    // US-24: price, fee and the position handed over are all shown first.
    await expect(modal.getByText('Platform fee (0.50%)')).toBeVisible();
    await expect(modal.getByText('The position you receive')).toBeVisible();

    // US-23: the guard rails come pre-filled from the live values.
    await expect(modal.locator('#l-price')).not.toHaveValue('');
    await expect(modal.locator('#l-net')).not.toHaveValue('');
    await expect(modal.locator('#l-hf')).not.toHaveValue('');

    const approve = modal.getByRole('button', { name: 'Approve USDC' });
    if (await approve.count() > 0) {
      await approve.click();
      await expectDone(page);
      await settled(modal, /^Confirm purchase$/);
    }

    await modal.getByRole('button', { name: 'Confirm purchase' }).click();
    await expectDone(page);
    await waitForIndexer();

    // US-22: ownership moved and the listing is gone from the market.
    const position = await waitForApi<{ owner: string; listing: unknown }>(
      '/api/positions/2',
      (p) => p.owner.toLowerCase() === ACCOUNTS.Bob.toLowerCase(),
    );
    expect(position.listing).toBeNull();

    await page.goto('/#/market');
    await expect(page.locator('a.card')).toHaveCount(1);
  });

  test('US-26, US-13: a sold listing cannot be bought again', async ({ page }) => {
    await connect(page, 'Carol');
    await page.goto('/#/listing/2');
    await expect(page.getByText('Listing not found').or(page.getByText('not listed'))).toBeVisible();
  });

  test('US-30, US-25: the sale appears in the history with amounts', async ({ page }) => {
    await connect(page, 'Bob');
    await page.goto('/#/history');
    const row = page.locator('table tbody tr', { hasText: 'Sold' }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('5,500 USDC');
  });

  test('US-31, US-32: the bought position is now managed by the buyer', async ({ page }) => {
    await connect(page, 'Bob');
    await page.goto('/#/position/2');
    // The buyer sees the seller side controls, which only the controller gets. The
    // listing form starts at the approval step for an address that has not used it.
    await expect(page.getByRole('heading', { name: 'List for sale' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^(Approve the marketplace|Create listing)$/ }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add collateral' }).first()).toBeVisible();
  });
});
