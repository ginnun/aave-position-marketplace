import { expect, test } from '@playwright/test';
import {
  ACCOUNTS, apiGet, buyListing, connect, expectDone, readPrice, settled, setPrice, waitForApi,
  waitForIndexer, warp,
} from '../helpers';

/** Alice keeps position #1 from the seed, healthy and unlisted. */
const TOKEN = '1';

test.describe('Safety while listed', () => {
  // The WETH price is shared state. Putting it back only at the end of the test that moved it
  // means one failed assertion mid-test leaves every later test running against 1500, and a
  // single root cause turns into a page of unrelated failures. The seed price is read rather
  // than assumed, so this stays right if the seed changes.
  let seedWethPrice = 0;
  test.beforeAll(async () => { seedWethPrice = await readPrice('WETH'); });
  test.afterAll(async () => {
    if (seedWethPrice > 0) await setPrice('WETH', seedWethPrice);
  });

  test('US-08: the seller lists at a fixed price', async ({ page }) => {
    await connect(page, 'Alice');
    await page.goto(`/#/position/${TOKEN}`);

    // Fill the price first. "Create listing" is disabled while the field is empty, so a seller
    // who has already approved the marketplace would never see it enabled.
    await page.locator('#l-fixed').fill('4000');
    await page.locator('#l-days').fill('5');
    await page.locator('#l-minhf').fill('1.50');

    await settled(page, /^(Approve the marketplace|Create listing)$/);
    const approve = page.getByRole('button', { name: 'Approve the marketplace' });
    if (await approve.count() > 0) {
      await approve.click();
      await expectDone(page);
    }

    // The discount against net value is shown before anything is signed.
    await expect(page.getByText(/against net value/)).toBeVisible();

    await page.getByRole('button', { name: 'Create listing' }).click();
    await expectDone(page);
    await waitForIndexer();

    const listing = await waitForApi<{ seller: string; status: string }>(
      `/api/listings/${TOKEN}`,
      (l) => l.seller.toLowerCase() === ACCOUNTS.Alice.toLowerCase(),
    );
    expect(listing.status).toBe('active');
  });

  /// A found issue: listing moves the token to the marketplace, and filtering on the owner
  /// alone dropped the position out of the seller's own portfolio while it was on sale.
  test('US-31: a listed position stays in the seller portfolio', async ({ page }) => {
    await connect(page, 'Alice');
    await page.goto('/#/positions');
    await expect(page.getByRole('link', { name: new RegExp(`#${TOKEN}\\b`) }).first())
      .toBeVisible();
    await expect(page.locator('a.card', { hasText: `#${TOKEN}` }).getByText('Listed')).toBeVisible();

    const owned = await apiGet<{ items: Array<{ tokenId: string }> }>(
      `/api/positions?owner=${ACCOUNTS.Alice}`,
    );
    expect(owned.items.map((p) => p.tokenId)).toContain(TOKEN);
  });

  test('US-15: the seller cannot weaken a listed position', async ({ page }) => {
    await connect(page, 'Alice');
    await page.goto(`/#/position/${TOKEN}`);

    await page.getByRole('button', { name: 'Withdraw collateral' }).first().click();
    await expect(page.getByText(/While listed you cannot withdraw collateral/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Withdraw collateral' }).last()).toBeDisabled();

    await page.getByRole('button', { name: 'Borrow', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Borrow', exact: true }).last()).toBeDisabled();
  });

  /// A found issue: WETH cannot be borrowed on this market, so switching to Borrow dropped it
  /// from the list while it stayed selected, and the transaction went to the wrong reserve.
  test('US-05: switching to borrow moves the selection off an asset that cannot be borrowed', async ({ page }) => {
    await connect(page, 'Alice');
    await page.goto(`/#/position/${TOKEN}`);
    await expect(page.locator('#m-asset')).toHaveValue('WETH');

    await page.getByRole('button', { name: 'Borrow', exact: true }).first().click();

    const options = page.locator('#m-asset option');
    await expect(options.filter({ hasText: /^WETH$/ })).toHaveCount(0);
    const selected = await page.locator('#m-asset').inputValue();
    expect(selected).not.toBe('WETH');
    await expect(options.filter({ hasText: new RegExp(`^${selected}$`) })).toHaveCount(1);
  });

  test('US-16: the seller can still strengthen a listed position', async ({ page }) => {
    await connect(page, 'Alice');
    await page.goto(`/#/position/${TOKEN}`);
    const before = await apiGet<{ healthFactor: string }>(`/api/positions/${TOKEN}`);

    await page.getByRole('button', { name: 'Repay', exact: true }).first().click();
    await page.locator('#m-asset').selectOption('USDT');
    await page.locator('#m-amount').fill('100');
    await expect(page.getByText('Health factor after this')).toBeVisible();

    // The form decides between Approve and Repay from an allowance read that is still in
    // flight. Reading the button set before it lands sees no Approve, skips it, and Repay
    // then fails on the allowance.
    await settled(page, /^(Approve USDT|Repay)$/);
    const approve = page.getByRole('button', { name: 'Approve USDT' });
    if (await approve.count() > 0) {
      await approve.click();
      await expectDone(page);
    }
    await page.getByRole('button', { name: 'Repay', exact: true }).last().click();
    await expectDone(page);
    await waitForIndexer();

    const after = await apiGet<{ healthFactor: string }>(`/api/positions/${TOKEN}`);
    expect(BigInt(after.healthFactor)).toBeGreaterThan(BigInt(before.healthFactor));
  });

  test('US-10: a price fall invalidates the listing, and adding collateral revives it', async ({ page }) => {
    await connect(page, 'Carol');

    await setPrice('WETH', 1500);
    await waitForApi<{ status: string }>(`/api/listings/${TOKEN}`, (l) => l.status === 'invalid');

    await page.goto(`/#/listing/${TOKEN}`);
    await expect(page.getByText('Invalid').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Buy', exact: true })).toBeDisabled();

    // The seller tops the position up and the listing becomes buyable again.
    await connect(page, 'Alice');
    await page.goto(`/#/position/${TOKEN}`);
    await page.getByRole('button', { name: 'Add collateral' }).first().click();
    await page.locator('#m-asset').selectOption('WETH');
    await page.locator('#m-amount').fill('2');
    await settled(page, /^(Approve WETH|Add collateral)$/);
    const approve = page.getByRole('button', { name: 'Approve WETH' });
    if (await approve.count() > 0) {
      await approve.click();
      await expectDone(page);
    }
    await page.getByRole('button', { name: 'Add collateral' }).last().click();
    await expectDone(page);
    await waitForIndexer();

    await waitForApi<{ status: string }>(`/api/listings/${TOKEN}`, (l) => l.status === 'active');

    // And the sale goes through.
    await connect(page, 'Carol');
    await buyListing(page, TOKEN);
    await expectDone(page);
    await waitForIndexer();

    await waitForApi<{ owner: string }>(
      `/api/positions/${TOKEN}`,
      (p) => p.owner.toLowerCase() === ACCOUNTS.Carol.toLowerCase(),
    );

    await setPrice('WETH', seedWethPrice);
  });

  test('US-23: a guard rail that is crossed stops the purchase and names itself', async ({ page }) => {
    // Carol relists what she just bought, then Alice tries to buy under a low ceiling.
    await connect(page, 'Carol');
    await page.goto(`/#/position/${TOKEN}`);
    await settled(page, /^(Approve the marketplace|Create listing)$/);
    const approve = page.getByRole('button', { name: 'Approve the marketplace' });
    if (await approve.count() > 0) {
      await approve.click();
      await expectDone(page);
    }
    await page.locator('#l-fixed').fill('3000');
    await page.getByRole('button', { name: 'Create listing' }).click();
    await expectDone(page);
    await waitForIndexer();

    await connect(page, 'Alice');
    await page.goto(`/#/listing/${TOKEN}`);
    await page.getByRole('button', { name: 'Buy', exact: true }).click();
    const modal = page.getByRole('dialog');
    await settled(modal, /^(Approve USDC|Confirm purchase)$/);
    // A ceiling far below the asking price.
    await modal.locator('#l-price').fill('1');
    const approveUsdc = modal.getByRole('button', { name: 'Approve USDC' });
    if (await approveUsdc.count() > 0) {
      await approveUsdc.click();
      await expectDone(page);
      await settled(modal, /^Confirm purchase$/);
    }
    await modal.getByRole('button', { name: 'Confirm purchase' }).click();
    await expect(page.getByText('The price is above your highest price.')).toBeVisible();

    // The message alone proves nothing: it could come from a check in the interface while the
    // sale went through anyway. Ask the chain who owns the position and whether it is still
    // listed. Carol listed it, so Carol must still be the seller.
    const still = await apiGet<{ owner: string; listing: { seller: string } | null }>(
      `/api/positions/${TOKEN}`,
    );
    expect(still.listing).not.toBeNull();
    expect(still.owner.toLowerCase()).not.toBe(ACCOUNTS.Alice.toLowerCase());
  });

  test('US-11: the seller cancels and gets the position back with full control', async ({ page }) => {
    await connect(page, 'Carol');
    await page.goto(`/#/position/${TOKEN}`);
    await page.getByRole('button', { name: 'Cancel listing' }).click();
    await expectDone(page);
    await waitForIndexer();

    await page.reload();
    // The first match is the tab, and the tab stays enabled even while the position is listed,
    // so asserting on it proved nothing about control coming back. Open the tab and check the
    // form the tab reveals, plus the absence of the refusal the listed state shows.
    await page.getByRole('button', { name: 'Withdraw collateral' }).first().click();
    // The submit button is disabled on an empty amount whatever the escrow says, so asserting
    // on it before filling one would pass for the wrong reason. With an amount in place the
    // only thing left that can disable it is the listed state.
    await page.locator('#m-amount').fill('0.01');
    await expect(page.getByRole('button', { name: 'Withdraw collateral' }).last()).toBeEnabled();
    await expect(page.getByText(/While listed you cannot withdraw/)).toHaveCount(0);
    const position = await waitForApi<{ owner: string; listing: unknown }>(
      `/api/positions/${TOKEN}`,
      (p) => p.listing === null,
    );
    expect(position.owner.toLowerCase()).toBe(ACCOUNTS.Carol.toLowerCase());
  });

  test('US-13: an expired listing stops being buyable', async ({ page }) => {
    await connect(page, 'Carol');
    await page.goto(`/#/position/${TOKEN}`);
    await page.locator('#l-fixed').fill('3000');
    await page.locator('#l-days').fill('1');
    await page.getByRole('button', { name: 'Create listing' }).click();
    await expectDone(page);
    await waitForIndexer();

    await warp(2 * 86400);
    await waitForApi<{ status: string }>(`/api/listings/${TOKEN}`, (l) => l.status === 'expired');

    await connect(page, 'Alice');
    await page.goto(`/#/listing/${TOKEN}`);
    await expect(page.getByRole('button', { name: 'Buy', exact: true })).toBeDisabled();
  });
});
