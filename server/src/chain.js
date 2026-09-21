import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http } from 'viem';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);
export const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';

/// Endpoints a browser may be told about. An operator's own RPC url often carries an API key in
/// the path, so it is never echoed: set PUBLIC_RPC_URL to say what visitors should use.
const PUBLIC_FALLBACK = {
  1: 'https://ethereum-rpc.publicnode.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  31337: 'http://127.0.0.1:8545',
};

export const PUBLIC_RPC_URL =
  process.env.PUBLIC_RPC_URL ?? PUBLIC_FALLBACK[CHAIN_ID] ?? null;

const deploymentPath = join(ROOT, 'deploy', `${CHAIN_ID}.json`);
if (!existsSync(deploymentPath)) {
  console.error(`No deployment found for chain ${CHAIN_ID}.`);
  console.error(`Expected ${deploymentPath}. Run "npm run chain" first.`);
  process.exit(1);
}

export const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));
export const abi = JSON.parse(readFileSync(join(ROOT, 'shared', 'abi.json'), 'utf8'));
export const { assets } = JSON.parse(readFileSync(join(ROOT, 'shared', 'assets.json'), 'utf8'));

export const assetByAddress = new Map(
  assets.map((a) => [a.address.toLowerCase(), a]),
);
export const assetByAToken = new Map(
  assets.map((a) => [a.aToken.toLowerCase(), a]),
);

/// A local fork keeps the Sepolia contracts but answers on a different chain id.
const chain = {
  id: CHAIN_ID,
  name: CHAIN_ID === 11155111 ? 'Sepolia' : 'Local fork',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
};

export const client = createPublicClient({ chain, transport: http(RPC_URL) });

/// viem puts "URL: <endpoint>" into its error messages, so a raw message would hand the operator's
/// private RPC url (API key and all) to anyone reading /api/health. Every error text that leaves
/// this process goes through here first.
export function redact(err) {
  const text = String(err?.message ?? err ?? 'unknown error');
  return text
    .split('\n')
    .filter((line) => !/^\s*URL:/i.test(line))
    .join('\n')
    .split(RPC_URL)
    .join('<rpc>')
    .trim();
}

export const POOL_ABI = [
  {
    type: 'function',
    name: 'getUserAccountData',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getUserEMode',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
];

export const PROVIDER_ABI = [
  {
    type: 'function',
    name: 'getPriceOracle',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
];

export const ORACLE_ABI = [
  {
    type: 'function',
    name: 'getAssetPrice',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
];
