import { useCallback, useRef, useState } from 'react';
import type { Abi, Address } from 'viem';
import { useWallet } from './wallet';
import { explainError, type FriendlyError } from './contracts';
import { useI18n } from './i18n';

export type TxStatus = 'idle' | 'simulating' | 'signing' | 'pending' | 'success' | 'error';

export type TxCall = {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
};

/**
 * Runs one contract call end to end: simulate, sign, wait for the receipt.
 * The simulation is what turns a contract revert into a readable sentence
 * before the person pays any gas.
 */
export function useTx() {
  const { walletClient, publicClient, address, chainId, expectedChainId, switchChain } = useWallet();
  const { lang } = useI18n();
  const [status, setStatus] = useState<TxStatus>('idle');
  const [hash, setHash] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);

  const reset = useCallback(() => {
    setStatus('idle');
    setHash(null);
    setError(null);
  }, []);

  // `busy` is derived from state, so it is still false for the second of two calls made in the
  // same tick: a double click, or two components sharing this hook. That would open two wallet
  // prompts and send two transactions, and the second one reverts after burning gas.
  const inFlight = useRef(false);

  const send = useCallback(async (call: TxCall): Promise<boolean> => {
    if (!walletClient || !address) return false;
    if (inFlight.current) return false;
    inFlight.current = true;
    setError(null);
    setHash(null);
    try {
      // The banner alone was not enough: every button stayed live on the wrong network, and
      // these contract addresses mean something different on another chain. One gate here
      // covers every call, because every call goes through this function.
      if (chainId !== null && chainId !== expectedChainId) {
        await switchChain();
        // Ask the wallet, not this client: `walletClient.chain` is the chain this build was
        // configured with, and the `chainChanged` event that updates `chainId` has not
        // arrived yet at this point.
        const live = await walletClient.getChainId().catch(() => null);
        if (live !== expectedChainId) {
          setStatus('error');
          setError({
            message: lang === 'tr'
              ? 'Cüzdan başka bir ağda. Doğru ağa geçip tekrar deneyin.'
              : 'The wallet is on another network. Switch to the right one and try again.',
            rejected: false,
          });
          return false;
        }
      }
      setStatus('simulating');
      const { request } = await publicClient.simulateContract({
        ...call,
        account: address,
      } as never);

      setStatus('signing');
      const txHash = await walletClient.writeContract(request as never);
      setHash(txHash);

      setStatus('pending');
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        setStatus('error');
        setError({ message: lang === 'tr' ? 'İşlem zincirde başarısız oldu.' : 'The transaction failed on chain.', rejected: false });
        return false;
      }
      setStatus('success');
      // The chain moved because of this transaction, so any shared snapshot is already wrong.
      const { invalidateChainCache } = await import('./chainRead');
      invalidateChainCache();
      window.dispatchEvent(new CustomEvent('chain:update'));
      return true;
    } catch (err) {
      setStatus('error');
      setError(explainError(err, lang));
      return false;
    } finally {
      inFlight.current = false;
    }
  }, [walletClient, publicClient, address, lang, chainId, expectedChainId, switchChain]);

  const busy = status === 'simulating' || status === 'signing' || status === 'pending';

  return { send, status, hash, error, busy, reset };
}
