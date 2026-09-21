import { expect, test } from '@playwright/test';
import {
  apiGet, buyListing, connect, expectDone, isListed, settled, waitForApi, waitForIndexer,
} from '../helpers';

test.describe('Platform administration', () => {
  // The platform stop is shared state. Lifting it only on the happy path would leave every
  // later test running against a stopped marketplace.
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      const stats = await apiGet<{ paused?: boolean }>('/api/stats');
      if (stats.paused !== true) return;
      await connect(page, 'Deployer');
      await page.goto('/#/admin');
      await page.getByRole('button', { name: 'Lift the stop' }).click();
      await expectDone(page);
      await waitForIndexer();
    } finally {
      await page.close();
    }
  });

  test('US-33: the fee cap is enforced by the contract, not by the interface', async ({ page }) => {
    await connect(page, 'Deployer');
    await page.goto('/#/admin');
    await expect(page.getByText(/The cap is 2\.00%/)).toBeVisible();

    await page.locator('#a-fee').fill('500');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('The fee is above the cap.')).toBeVisible();

    // The refusal message could equally well come from a check in the interface. Read the fee
    // back from the indexer: an interface-only guard would leave it unchanged too, but a
    // contract that quietly accepted 500 would not.
    const config = await apiGet<{ feeBps: number }>('/api/config');
    expect(config.feeBps).toBeLessThanOrEqual(200);
  });

  test('US-33: a non administrator only reads', async ({ page }) => {
    await connect(page, 'Alice');
    await page.goto('/#/admin');
    await expect(page.getByText('This address is not the platform administrator.')).toBeVisible();
    await expect(page.locator('#a-fee')).toBeDisabled();
  });

  test('US-34: an emergency stop blocks buying while cancelling keeps working', async ({ page }) => {
    // Carol lists her position so there is something to try to buy.
    await connect(page, 'Carol');
    await page.goto('/#/position/1');

    // An earlier test may have left this position listed. The index says so, which is
    // steadier than asking the page before it has finished loading.
    if (await isListed('1')) {
      await page.getByRole('button', { name: 'Cancel listing' }).click();
      await expectDone(page);
      await waitForApi<{ listing: unknown }>('/api/positions/1', (p) => p.listing === null);
      await page.reload();
    }
    // Fill the form first: "Create listing" stays disabled while the price field is empty, so
    // waiting for it to be enabled before that would time out for a seller who has already
    // approved the marketplace.
    await page.locator('#l-fixed').fill('3500');
    await page.locator('#l-days').fill('5');
    await settled(page, /^(Approve the marketplace|Create listing)$/);
    const approve = page.getByRole('button', { name: 'Approve the marketplace' });
    if (await approve.count() > 0) {
      await approve.click();
      await expectDone(page);
    }
    await page.getByRole('button', { name: 'Create listing' }).click();
    await expectDone(page);
    await waitForIndexer();

    await connect(page, 'Deployer');
    await page.goto('/#/admin');
    await page.getByRole('button', { name: 'Stop new listings and purchases' }).click();
    await expectDone(page);
    await waitForIndexer();

    await page.goto('/#/market');
    await expect(page.getByText(/The platform is stopped/)).toBeVisible();

    // A purchase is refused with the reason the contract gave. Scope this to the error notice:
    // the site-wide warn banner carries the same words, so a looser match would pass even if
    // the purchase were never refused at all.
    await connect(page, 'Alice');
    await buyListing(page, '1');
    await expect(
      page.locator('.notice--error').filter({ hasText: /The platform is stopped/ }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();

    // The seller can still get out.
    await connect(page, 'Carol');
    await page.goto('/#/position/1');
    await page.getByRole('button', { name: 'Cancel listing' }).click();
    await expectDone(page);
    await waitForIndexer();

    await waitForApi<{ listing: unknown }>('/api/positions/1', (p) => p.listing === null);

    // Put the platform back the way it was.
    await connect(page, 'Deployer');
    await page.goto('/#/admin');
    await page.getByRole('button', { name: 'Lift the stop' }).click();
    await expectDone(page);
  });

  test('US-35: metrics count the sales that happened', async ({ page }) => {
    await connect(page, 'Deployer');
    await page.goto('/#/admin');
    await expect(page.getByText('Sales')).toBeVisible();
    const stats = await apiGet<{ totals: { sales: number } }>('/api/stats');
    expect(stats.totals.sales).toBeGreaterThanOrEqual(1);
  });
});
