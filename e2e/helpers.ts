import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..');
export const RPC = process.env.LOCAL_RPC_URL ?? 'http://127.0.0.1:8545';
export const API = process.env.SERVER_URL ?? 'http://127.0.0.1:8787';
export const ACL_ADMIN = '0xfA0e305E0f46AB04f00ae6b5f4560d61a2183E00';

export const ACCOUNTS = {
  Deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  Alice: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  Bob: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  Carol: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
} as const;

export type AccountName = keyof typeof ACCOUNTS;

export function deployment() {
  return JSON.parse(readFileSync(join(ROOT, 'deploy', '31337.json'), 'utf8'));
}

export function feeds() {
  return JSON.parse(readFileSync(join(ROOT, 'deploy', '31337.feeds.json'), 'utf8'));
}

async function rpc(method: string, params: unknown[] = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** Moves an asset price on the local chain by writing to its mock feed. */
/** Reads a feed's current answer, so a test can put back exactly what it found. */
export async function readPrice(symbol: 'WETH' | 'LINK' | 'WBTC' | 'USDT'): Promise<number> {
  const feed = feeds()[symbol];
  const answer = BigInt(await rpc('eth_call', [{ to: feed, data: '0x50d25bcd' }, 'latest']));
  return Number(answer) / 1e8;
}

export async function setPrice(symbol: 'WETH' | 'LINK' | 'WBTC' | 'USDT', usd: number) {
  const feed = feeds()[symbol];
  const answer = BigInt(Math.round(usd * 1e8));
  // setAnswer(int256)
  const data = `0x99213cd8${answer.toString(16).padStart(64, '0')}`;
  const hash = await rpc('eth_sendTransaction', [{ from: ACL_ADMIN, to: feed, data, gas: '0x100000' }]);

  const receipt = await rpc('eth_getTransactionReceipt', [hash]);
  if (receipt && receipt.status === '0x0') {
    throw new Error(`setting the ${symbol} price reverted, transaction ${hash}`);
  }

  // Read it back. A price that did not move would make a test fail somewhere far
  // from here, with a message about the wrong thing.
  const written = BigInt(await rpc('eth_call', [{ to: feed, data: '0x50d25bcd' }, 'latest']));
  if (written !== answer) {
    throw new Error(`the ${symbol} feed still reads ${written}, expected ${answer}`);
  }

  await waitForIndexer();
}

export async function warp(seconds: number) {
  await rpc('evm_increaseTime', [seconds]);
  await rpc('evm_mine', []);
  await waitForIndexer();
}

export async function snapshot(): Promise<string> {
  return rpc('evm_snapshot', []);
}

export async function revert(id: string) {
  await rpc('evm_revert', [id]);
  await rpc('evm_mine', []);
  await waitForIndexer();
}

/** Waits until the indexer has seen the newest block, so the interface shows it. */
export async function waitForIndexer(timeoutMs = 25_000) {
  const head = BigInt(await rpc('eth_blockNumber'));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/api/health`);
    if (res.ok) {
      const body = await res.json();
      if (BigInt(body.head) >= head) return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('the indexer did not catch up');
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

/** Connects the built in test wallet, which needs no browser extension. */
export async function connect(page: Page, who: AccountName) {
  await page.goto('/#/market');
  const chip = page.locator('.wallet-chip');
  if (await chip.count() > 0) {
    await page.getByRole('button', { name: 'Disconnect' }).click();
  }
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('button', { name: who, exact: true }).click();
  await expect(chip).toContainText(who);
}

export async function gotoTab(page: Page, name: string) {
  await page.getByRole('link', { name, exact: true }).click();
}

/** Waits out a transaction the interface started.
 *  An error notice ends the wait at once and reports what the contract said. */
export async function expectDone(page: Page) {
  const done = page.getByText('Done', { exact: true });
  const failed = page.locator('.notice--error');

  // The result of the previous step can still be on screen. Wait for it to clear, so
  // this call reports the step that just started rather than the one before it.
  const clearBy = Date.now() + 10_000;
  while (Date.now() < clearBy && await done.count() > 0) {
    await page.waitForTimeout(100);
  }
  // If it never cleared, the wait below would return on the *previous* step's notice and the
  // test would pass without the new transaction ever finishing. Fail loudly instead.
  if (await done.count() > 0) {
    throw new Error('the previous result never cleared, so this wait cannot tell the steps apart');
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await done.count() > 0) return;
    if (await failed.count() > 0) {
      throw new Error(`the interface reported: ${await failed.first().innerText()}`);
    }
    await page.waitForTimeout(250);
  }
  throw new Error('the transaction never finished');
}

/** Waits until a form has decided which action it needs, so no click races the
 *  allowance read that is still in flight. */
export async function settled(scope: Page | ReturnType<Page['locator']>, names: RegExp) {
  await expect(scope.getByRole('button', { name: names }).first()).toBeEnabled({ timeout: 30_000 });
}

/** Opens the purchase dialog, approves the payment asset when asked, and confirms. */
export async function buyListing(page: Page, tokenId: string, paymentSymbol = 'USDC') {
  await page.goto(`/#/listing/${tokenId}`);
  await page.getByRole('button', { name: 'Buy', exact: true }).click();

  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();
  await settled(modal, new RegExp(`^(Approve ${paymentSymbol}|Confirm purchase)$`));

  const approve = modal.getByRole('button', { name: `Approve ${paymentSymbol}` });
  if (await approve.count() > 0) {
    await approve.click();
    await expectDone(page);
    await settled(modal, /^Confirm purchase$/);
  }
  await modal.getByRole('button', { name: 'Confirm purchase' }).click();
  return modal;
}

/** Polls a route until it answers the way the test expects. Outcome beats appearance:
 *  this does not depend on any message staying on screen. */
export async function waitForApi<T>(
  path: string,
  accept: (body: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const body = await apiGet<T>(path);
      last = body;
      if (accept(body)) return body;
    } catch (err) {
      last = err instanceof Error ? err.message : err;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${path} never matched. Last answer: ${JSON.stringify(last)}`);
}

/** Asks the chain index whether a position is listed, rather than guessing from the page. */
export async function isListed(tokenId: string): Promise<boolean> {
  try {
    await apiGet(`/api/listings/${tokenId}`);
    return true;
  } catch {
    return false;
  }
}
