// Owner wallet via @near-wallet-selector. Loaded lazily so the story pages never ship wallet code.
// Browser wallets (MyNearWallet) redirect away and come back with the result in the URL; `readReturn` collects it.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NetworkId, Wallet, WalletSelector } from '@near-wallet-selector/core';
import type { WalletSelectorModal } from '@near-wallet-selector/modal-ui';
import type { FinalExecutionOutcome } from '@near-js/types';
import { Buffer } from 'buffer';
import type { Action } from './setup';

interface Loaded { network: NetworkId; selector: WalletSelector; modal: WalletSelectorModal }
let loaded: Loaded | null = null; let loading: Promise<Loaded> | null = null;

export async function getSelector(network: NetworkId): Promise<Loaded> {
  if (loaded && loaded.network === network) return loaded;
  if (loading) { const l = await loading; if (l.network === network) return l; }
  loading = (async () => {
    const [core, modalUi, mnw, meteor, hot, nightly] = await Promise.all([
      import('@near-wallet-selector/core'), import('@near-wallet-selector/modal-ui'), import('@near-wallet-selector/my-near-wallet'),
      import('@near-wallet-selector/meteor-wallet'), import('@near-wallet-selector/hot-wallet'), import('@near-wallet-selector/nightly'),
    ]);
    await import('@near-wallet-selector/modal-ui/styles.css');
    const selector = await core.setupWalletSelector({ network, modules: [mnw.setupMyNearWallet(), meteor.setupMeteorWallet(), hot.setupHotWallet(), nightly.setupNightly()] });
    const modal = modalUi.setupModal(selector, { description: 'Your wallet creates the accounts and signs the policy. The bridge never sees a key.' });
    loaded = { network, selector, modal }; loading = null; return loaded;
  })();
  return loading;
}

export interface WalletState { network: NetworkId; accountId: string | null; ready: boolean; error: string | null }

export function useWallet(network: NetworkId) {
  const [state, setState] = useState<WalletState>({ network, accountId: null, ready: false, error: null });
  const sub = useRef<{ unsubscribe(): void } | null>(null);
  useEffect(() => {
    let dead = false;
    setState(s => ({ ...s, network, ready: false, error: null }));
    getSelector(network).then(({ selector }) => {
      if (dead) return;
      sub.current?.unsubscribe();
      sub.current = selector.store.observable.subscribe(st => {
        const active = st.accounts.find(a => a.active) ?? st.accounts[0];
        setState(s => ({ ...s, network, accountId: active?.accountId ?? null, ready: true }));
      });
    }).catch(e => { if (!dead) setState(s => ({ ...s, ready: true, error: (e as Error).message })); });
    return () => { dead = true; sub.current?.unsubscribe(); sub.current = null; };
  }, [network]);

  const connect = useCallback(async () => { const { modal } = await getSelector(network); modal.show(); }, [network]);
  const disconnect = useCallback(async () => { const { selector } = await getSelector(network); if (selector.isSignedIn()) { const w = await selector.wallet(); await w.signOut(); } }, [network]);
  const wallet = useCallback(async (): Promise<Wallet> => { const { selector } = await getSelector(network); return selector.wallet(); }, [network]);
  return { ...state, connect, disconnect, wallet };
}

export const txHashOf = (o: FinalExecutionOutcome | void | undefined): string | undefined => {
  if (!o || typeof o !== 'object') return undefined;
  const t = (o as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } });
  return t.transaction?.hash ?? t.transaction_outcome?.id;
};

/** Sign and send one transaction; returns the hash, or undefined when the wallet redirected (the hash arrives via the URL). */
export async function signAndSend(w: Wallet, receiverId: string, actions: Action[], callbackUrl: string): Promise<string | undefined> {
  const out = await w.signAndSendTransaction({ receiverId, actions: actions as never, callbackUrl });
  return txHashOf(out);
}

export interface SignedMessageResult { accountId: string; publicKey: string; signature: string }
export async function signMessage(w: Wallet, p: { message: string; recipient: string; nonce: Uint8Array; callbackUrl: string; state?: string }): Promise<SignedMessageResult | undefined> {
  if (typeof w.signMessage !== 'function') throw new Error('NO_SIGN_MESSAGE');
  const r = await w.signMessage({ message: p.message, recipient: p.recipient, nonce: Buffer.from(p.nonce), callbackUrl: p.callbackUrl, state: p.state });
  return r ? { accountId: r.accountId, publicKey: r.publicKey, signature: r.signature } : undefined;
}

/** What a browser wallet put in the URL when it sent us back. Cleared from the address bar after reading. */
export interface WalletReturn { txHashes?: string[]; errorCode?: string; errorMessage?: string; signed?: SignedMessageResult & { state?: string } }
export function readReturn(): WalletReturn | null {
  const q = new URLSearchParams(window.location.search);
  const h = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const out: WalletReturn = {};
  if (q.get('transactionHashes')) out.txHashes = q.get('transactionHashes')!.split(',').filter(Boolean);
  if (q.get('errorCode')) { out.errorCode = q.get('errorCode')!; out.errorMessage = q.get('errorMessage') ?? undefined; }
  if (h.get('signature') && h.get('publicKey') && h.get('accountId')) out.signed = { accountId: h.get('accountId')!, publicKey: h.get('publicKey')!, signature: h.get('signature')!, state: h.get('state') ?? undefined };
  if (!out.txHashes && !out.errorCode && !out.signed) return null;
  window.history.replaceState(null, '', window.location.pathname);
  return out;
}
