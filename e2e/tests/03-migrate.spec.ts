import { expect, test } from '@playwright/test';
import { ACCOUNTS, apiGet, connect, expectDone, settled, waitForApi, waitForIndexer } from '../helpers';

test.describe('Carrying a position in and out', () => {
  test('US-03: a plain Aave position becomes tradable in one transaction', async ({ page }) => {
    await connect(page, 'Bob');
    await page.goto('/#/migrate');

    // The page reads the live Aave position before anything is signed.
    await expect(page.getByText('Health factor')).toBeVisible();
    await expect(page.locator('.risk__track')).toBeVisible();
    await expect(page.locator('table')).toContainText('WETH');
    await expect(page.locator('table')).toContainText('USDT');

    const before = await apiGet<{ total: number }>(`/api/positions?owner=${ACCOUNTS.Bob}`);

    await settled(page, /^(Approve WETH collateral|Carry the position in)$/);
    const approve = page.getByRole('button', { name: /^Approve WETH collateral$/ });
    if (await approve.count() > 0) {
      await approve.click();
      await expectDone(page);
    }

    await page.getByRole('button', { name: 'Carry the position in' }).click();
    await expectDone(page);
    await waitForIndexer();

    const after = await waitForApi<{ total: number; items: Array<{ tokenId: string; collateral: unknown[]; debt: unknown[] }> }>(
      `/api/positions?owner=${ACCOUNTS.Bob}`,
      (body) => body.total === before.total + 1,
    );

    const fresh = after.items.at(-1)!;
    expect(fresh.collateral.length).toBeGreaterThan(0);
    expect(fresh.debt.length).toBeGreaterThan(0);
  });

  test('US-03: the source Aave position is empty afterwards', async ({ page }) => {
    await connect(page, 'Bob');
    await page.goto('/#/migrate');
    await expect(page.getByText('No Aave position found for this address.')).toBeVisible();
  });

  test('US-06: the owner carries a position back to their own Aave account', async ({ page }) => {
    await connect(page, 'Bob');
    const owned = await apiGet<{ items: Array<{ tokenId: string; debt: unknown[] }> }>(
      `/api/positions?owner=${ACCOUNTS.Bob}`,
    );
    const target = owned.items.at(-1)!;

    await page.goto(`/#/position/${target.tokenId}`);
    await expect(page.getByRole('heading', { name: `Position #${target.tokenId}` })).toBeVisible();

    // Credit delegation first, then the move itself.
    await settled(page, /^(Delegate credit for USDT|Carry back to my account)$/);
    const delegate = page.getByRole('button', { name: /^Delegate credit for USDT$/ });
    if (await delegate.count() > 0) {
      await delegate.click();
      await expectDone(page);
    }

    await page.getByRole('button', { name: 'Carry back to my account' }).click();
    await expectDone(page);
    await waitForIndexer();

    // The tradable position is gone and the plain Aave position is back.
    await page.goto('/#/migrate');
    await expect(page.locator('.risk__track')).toBeVisible();
    await expect(page.getByText('No Aave position found for this address.')).toHaveCount(0);
  });
});
