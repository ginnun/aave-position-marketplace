import {
  BaseError, ContractFunctionRevertedError, UserRejectedRequestError,
  type Abi, type Address,
} from 'viem';

export type Abis = { PositionManager: Abi; Marketplace: Abi; PositionAccount: Abi };

let cached: Abis | null = null;

export async function loadAbis(): Promise<Abis> {
  if (cached) return cached;
  const res = await fetch('/abi.json');
  cached = (await res.json()) as Abis;
  return cached;
}

export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const satisfies Abi;

export const DEBT_TOKEN_ABI = [
  { type: 'function', name: 'approveDelegation', stateMutability: 'nonpayable', inputs: [{ name: 'delegatee', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'borrowAllowance', stateMutability: 'view', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const satisfies Abi;

export const POOL_ABI = [
  {
    type: 'function', name: 'getUserAccountData', stateMutability: 'view',
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
] as const satisfies Abi;

export const FAUCET_ABI = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
] as const satisfies Abi;

export const WETH_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
] as const satisfies Abi;

export type ListingInput = {
  seller: Address;
  paymentAsset: Address;
  allowedBuyer: Address;
  fixedPrice: bigint;
  minPrice: bigint;
  rateBps: number;
  expiry: bigint;
  minHealthFactor: bigint;
  quickSale: boolean;
};

export type BuyLimitsInput = {
  maxPrice: bigint;
  minNetValueBase: bigint;
  maxDebtBase: bigint;
  minHealthFactor: bigint;
  deadline: bigint;
};

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
export const MAX_UINT = (1n << 256n) - 1n;

/** Contract error names mapped to something a person can act on. */
const MESSAGES: Record<string, { tr: string; en: string }> = {
  Escrowed: {
    tr: 'Pozisyon ilanda. Teminat çekme ve borç alma kapalı; önce ilanı iptal edin.',
    en: 'The position is listed. Withdrawing and borrowing are closed until you cancel it.',
  },
  NotController: {
    tr: 'Bu pozisyonu yönetme yetkiniz yok.',
    en: 'You are not allowed to manage this position.',
  },
  NotOwner: { tr: 'Bu pozisyonun sahibi değilsiniz.', en: 'You do not own this position.' },
  NotSeller: { tr: 'Bu ilanı yalnızca satıcısı değiştirebilir.', en: 'Only the seller can change this listing.' },
  NotListed: { tr: 'İlan bulunamadı. Satılmış, iptal edilmiş veya süresi dolmuş olabilir.', en: 'Listing not found. It may have sold, been cancelled or ended.' },
  AlreadyListed: { tr: 'Bu pozisyon zaten ilanda.', en: 'This position is already listed.' },
  ListingExpired: { tr: 'İlanın süresi doldu.', en: 'The listing has ended.' },
  ListingInvalid: {
    tr: 'Health factor satıcının eşiğinin altında. Satın alma kapalı.',
    en: 'The health factor is under the seller threshold, so buying is closed.',
  },
  SelfPurchase: { tr: 'Kendi ilanınızı satın alamazsınız.', en: 'You cannot buy your own listing.' },
  NotAllowedBuyer: { tr: 'Bu özel ilan başka bir adrese ayrılmış.', en: 'This private listing is reserved for another address.' },
  Paused: { tr: 'Platform acil durdurma modunda. İptal ve geri alma çalışıyor.', en: 'The platform is stopped. Cancelling and carrying back still work.' },
  PaymentAssetNotAllowed: { tr: 'Bu ödeme varlığı kabul edilmiyor.', en: 'This payment asset is not accepted.' },
  FeeTooHigh: { tr: 'Ücret üst sınırın üstünde.', en: 'The fee is above the cap.' },
  BadParams: { tr: 'Girilen değerler geçersiz.', en: 'Those values are not valid.' },
  NoPrice: { tr: 'Ödeme varlığının fiyatı okunamadı.', en: 'The payment asset price could not be read.' },
  ZeroAmount: { tr: 'Tutar sıfır olamaz.', en: 'The amount cannot be zero.' },
  UnknownPosition: { tr: 'Pozisyon bulunamadı.', en: 'Position not found.' },
};

const LIMIT_NAMES = ['Price', 'NetValue', 'Debt', 'HealthFactor', 'Deadline', 'PaymentAsset'] as const;
const LIMIT_TEXT: Record<string, { tr: string; en: string }> = {
  Price: { tr: 'Fiyat, belirlediğiniz en yüksek fiyatın üstünde.', en: 'The price is above your highest price.' },
  NetValue: { tr: 'Net değer, belirlediğiniz alt sınırın altında.', en: 'The net value is under your floor.' },
  Debt: { tr: 'Borç, belirlediğiniz üst sınırın üstünde.', en: 'The debt is above your ceiling.' },
  HealthFactor: { tr: 'Health factor, belirlediğiniz alt sınırın altında.', en: 'The health factor is under your floor.' },
  Deadline: { tr: 'İşlem geçerlilik süresi doldu.', en: 'Your validity window has passed.' },
  PaymentAsset: {
    tr: 'İlanın ödeme varlığı siz bakarken değişti. Sayfayı yenileyip tekrar deneyin.',
    en: 'The listing changed its payment asset while you were looking. Reload and try again.',
  },
};

// Order matters: these are the enum positions the contract sends back. Append only, and keep
// this in step with PositionManager.Blocker.
export const BLOCKERS = ['None', 'NoCollateral', 'IsolationMode', 'SiloedBorrowing', 'ReserveInactive', 'ReserveFrozen', 'ReservePaused', 'EModeMismatch', 'DebtAboveLtv', 'CollateralFlagMismatch', 'BorrowingDisabled', 'FlashLoanDisabled'] as const;

function unknownReason(lang: 'tr' | 'en') {
  return lang === 'tr'
    ? 'Sözleşme bu arayüzün tanımadığı bir nedenle reddetti. Ayrıntı satırındaki değeri iletin.'
    : 'The contract refused for a reason this interface does not know. Report the value on the detail line.';
}

export type FriendlyError = { message: string; detail?: string; rejected: boolean };

/** Turns a revert into a sentence, and keeps the raw reason for the details line. */
export function explainError(err: unknown, lang: 'tr' | 'en'): FriendlyError {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) {
      return {
        message: lang === 'tr' ? 'İşlem cüzdanda reddedildi.' : 'The transaction was rejected in the wallet.',
        rejected: true,
      };
    }
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      const args = reverted.data?.args ?? [];

      // An index this build does not know about means the contract is newer than the
      // interface. Showing the raw number is honest; falling back to the first entry would
      // send the reader off to fix a limit or a blocker that was never the problem.
      if (name === 'LimitExceeded') {
        const index = Number(args[0]);
        const which = LIMIT_NAMES[index];
        if (which === undefined) {
          return { message: unknownReason(lang), detail: `LimitExceeded(${args[0]})`, rejected: false };
        }
        return { message: LIMIT_TEXT[which][lang], detail: `LimitExceeded(${which})`, rejected: false };
      }
      if (name === 'MigrationBlocked') {
        const index = Number(args[0]);
        const which = BLOCKERS[index];
        if (which === undefined) {
          return { message: unknownReason(lang), detail: `MigrationBlocked(${args[0]})`, rejected: false };
        }
        return {
          message: lang === 'tr'
            ? `Bu pozisyon taşınamıyor: ${which}`
            : `This position cannot be carried: ${which}`,
          detail: `MigrationBlocked(${which})`,
          rejected: false,
        };
      }
      if (name && MESSAGES[name]) {
        return { message: MESSAGES[name][lang], detail: name, rejected: false };
      }
      if (reverted.reason) {
        return {
          message: lang === 'tr' ? `Zincir işlemi reddetti: ${reverted.reason}` : `The chain refused: ${reverted.reason}`,
          detail: reverted.reason,
          rejected: false,
        };
      }
    }
    return { message: err.shortMessage || err.message, detail: err.details, rejected: false };
  }
  return { message: err instanceof Error ? err.message : String(err), rejected: false };
}
