// /setup: five calm steps. The owner's wallet creates the accounts and signs the chip policy; the bridge stores no keys.
// Browser wallets redirect away mid-step, so the draft lives in localStorage and the URL return is read on mount.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NetworkId } from '@near-wallet-selector/core';
import { Page } from '../components/Page';
import { useStatus } from '../hooks/useBridge';
import { api, errorMessage, isNotAvailable } from '../lib/api';
import { explorerAccount, explorerTx, formatAmount, short } from '../lib/format';
import { Link } from '../lib/router';
import { agentCreateActions, chipPolicy, describeActions, parseReceivers, randomNonce, registryActions, sha256Hex, subAccountProblem, suggestNames, sumNear, toBase64, walletCreateActions, type Action, type ChipPolicyInput } from '../lib/setup';
import type { PolicySetResult } from '../lib/types';
import { readReturn, signAndSend, signMessage, useWallet, type SignedMessageResult } from '../lib/wallet';

type Step = 1 | 2 | 3 | 4 | 5;
type TxKind = 'wallet' | 'agent' | 'registry';
interface Draft {
  step: Step; network: NetworkId; owner?: string;
  wallet: string; agent: string; receivers: string; budget: string; registry: string;
  tx: Partial<Record<TxKind, string>>; pending?: TxKind | 'policy';
  policy?: { seq: number; message: string; nonce: string; policy_hash: string; policy: ChipPolicyInput };
  saved?: boolean; done?: PolicySetResult;
}
const KEY = 'fuse.setup.v1';
const EMPTY: Draft = { step: 1, network: 'testnet', wallet: '', agent: '', receivers: '', budget: '3', registry: '', tx: {} };
const load = (): Draft => { try { const s = localStorage.getItem(KEY); return s ? { ...EMPTY, ...(JSON.parse(s) as Partial<Draft>) } : EMPTY; } catch { return EMPTY; } };
const STEPS = ['Wallet', 'Chip', 'Accounts', 'Bridge', 'Policy'] as const;
const WASM = 'fuse_wallet_v2.wasm';
const near = (y: string) => formatAmount(y, 'near');

function Rail({ step }: { step: Step }) {
  return (
    <ol className="flex flex-wrap gap-x-6 gap-y-2 text-[14px]" aria-label="Steps">
      {STEPS.map((label, i) => {
        const n = (i + 1) as Step; const state = n < step ? 'done' : n === step ? 'now' : 'next';
        return <li key={label} aria-current={state === 'now' ? 'step' : undefined} className={`flex items-center gap-2 ${state === 'now' ? 'text-ink' : state === 'done' ? 'text-accent-deep' : 'text-ink-3'}`}><span className="mono text-[12px]">{state === 'done' ? '✓' : n}</span>{label}</li>;
      })}
    </ol>
  );
}
const Err = ({ children }: { children: React.ReactNode }) => <p className="mt-3 text-[14px] text-red">{children}</p>;
const Note = ({ children }: { children: React.ReactNode }) => <p className="mt-3 text-[14px] text-ink-2">{children}</p>;

export function SetupPage() {
  const { data: status } = useStatus();
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(load);
  const [netPicked, setNetPicked] = useState(() => !!localStorage.getItem(KEY));
  const patch = useCallback((p: Partial<Draft> | ((x: Draft) => Partial<Draft>)) => setD(x => { const n = { ...x, ...(typeof p === 'function' ? p(x) : p) }; try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* private mode */ } return n; }), []);
  useEffect(() => { if (!netPicked && status?.network && (status.network === 'testnet' || status.network === 'mainnet')) { patch({ network: status.network }); setNetPicked(true); } }, [status?.network, netPicked, patch]);

  const w = useWallet(d.network);
  const owner = w.accountId ?? d.owner ?? '';
  useEffect(() => { if (w.accountId && w.accountId !== d.owner) { const s = suggestNames(w.accountId); patch(x => ({ owner: w.accountId!, wallet: !x.wallet || x.wallet === suggestNames(x.owner ?? '').wallet ? s.wallet : x.wallet, agent: !x.agent || x.agent === suggestNames(x.owner ?? '').agent ? s.agent : x.agent })); } }, [w.accountId, d.owner, patch]);

  const info = useQuery({ queryKey: ['setup'], queryFn: api.setupInfo, refetchInterval: 3000, retry: false });
  const cfg = useQuery({ queryKey: ['config'], queryFn: api.config, retry: false });
  useEffect(() => { const r = cfg.data?.effective.REGISTRY_CONTRACT; if (r && !d.registry) patch({ registry: r }); }, [cfg.data, d.registry, patch]);
  const chip = info.data?.chip ?? null;
  const methods = info.data?.agent_methods ?? ['pay', 'record_refusal', 'request_chain_sig'];
  const artifactMeta = info.data?.artifacts.find(a => a.name === WASM);
  const artifact = useQuery({
    queryKey: ['artifact', WASM, artifactMeta?.sha256], enabled: !!artifactMeta?.sha256, staleTime: Infinity, retry: false,
    queryFn: async () => { const buf = await api.artifact(WASM); const sha = await sha256Hex(buf); if (sha !== artifactMeta!.sha256) throw new Error(`sha256 mismatch: got ${sha.slice(0, 12)}…, bridge says ${artifactMeta!.sha256!.slice(0, 12)}…`); return { code: new Uint8Array(buf), sha }; },
  });

  const receivers = useMemo(() => parseReceivers(d.receivers), [d.receivers]);
  const walletDeposit = sumNear(info.data?.costs.wallet_storage_near ?? '2.9', d.budget);
  const agentDeposit = sumNear(info.data?.costs.agent_min_near ?? '0.1');
  const walletProblem = subAccountProblem(d.wallet, owner);
  const agentProblem = subAccountProblem(d.agent, owner) ?? (d.agent === d.wallet ? 'The agent and the wallet contract need different names.' : null);
  const callbackUrl = `${window.location.origin}/setup`;

  // ---- transactions ----
  const txFor = (kind: TxKind): { receiverId: string; actions: Action[] } | null => {
    if (!chip) return null;
    if (kind === 'wallet') return artifact.data && walletDeposit ? { receiverId: d.wallet, actions: walletCreateActions({ owner, agent: d.agent, chipPubkey: chip.pubkey, depositYocto: walletDeposit, code: artifact.data.code, receivers }) } : null;
    if (kind === 'agent') return agentDeposit ? { receiverId: d.agent, actions: agentCreateActions({ wallet: d.wallet, chipPubkey: chip.pubkey, depositYocto: agentDeposit, methods }) } : null;
    return d.registry ? { receiverId: d.wallet, actions: registryActions(d.registry) } : null;
  };
  const sign = useMutation({
    mutationFn: async (kind: TxKind) => { const t = txFor(kind); if (!t) throw new Error('Not ready to sign.'); patch({ pending: kind }); const wallet = await w.wallet(); const hash = await signAndSend(wallet, t.receiverId, t.actions, callbackUrl); return { kind, hash }; },
    onSuccess: ({ kind, hash }) => { if (hash) patch(x => ({ tx: { ...x.tx, [kind]: hash }, pending: undefined })); },
    onError: () => patch({ pending: undefined }),
  });

  // ---- bridge config ----
  const save = useMutation({
    mutationFn: () => api.saveConfig({ NEAR_NETWORK: d.network, OWNER_ACCOUNT: owner, WALLET_CONTRACT: d.wallet, AGENT_ACCOUNT: d.agent, REGISTRY_CONTRACT: d.registry }),
    onSuccess: () => { patch({ saved: true }); void qc.invalidateQueries({ queryKey: ['config'] }); void qc.invalidateQueries({ queryKey: ['status'] }); void qc.invalidateQueries({ queryKey: ['setup'] }); },
  });

  // ---- chip policy ----
  const policyObj = useMemo(() => chipPolicy({ agent: d.agent, wallet: d.wallet, methods, receivers }), [d.agent, d.wallet, methods, receivers]);
  // The exact message is shown before the wallet opens; signing reuses its seq so what you read is what you sign.
  const preview = useQuery({ queryKey: ['policy-message', policyObj], queryFn: () => api.policyMessage(policyObj), enabled: d.step === 5 && !!chip && !!d.agent && !!d.wallet, staleTime: 60_000, retry: false });
  const [countdown, setCountdown] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopCount = () => { if (timer.current) clearInterval(timer.current); timer.current = null; setCountdown(null); };
  const finishPolicy = useCallback(async (signed: SignedMessageResult, p: NonNullable<Draft['policy']>) => {
    setCountdown(30); timer.current = setInterval(() => setCountdown(c => (c === null || c <= 1 ? 0 : c - 1)), 1000);
    try {
      const r = await api.policySet(p.policy, { scheme: 'nep413', seq: p.seq, nonce: p.nonce, recipient: 'fuse', owner_pubkey: signed.publicKey, owner_sig: signed.signature });
      patch({ done: r, pending: undefined }); return r;
    } catch (e) {
      const body = (e as { body?: PolicySetResult }).body;
      const r: PolicySetResult = body && typeof body === 'object' ? { ...body, ok: false } : { ok: false, error: errorMessage(e) };
      patch({ done: r, pending: undefined }); return r;
    } finally { stopCount(); void qc.invalidateQueries({ queryKey: ['status'] }); }
  }, [patch, qc]);
  const policy = useMutation({
    mutationFn: async () => {
      const m = preview.data ?? await api.policyMessage(policyObj);
      const nonce = randomNonce();
      const p = { seq: m.seq, message: m.message, nonce: toBase64(nonce), policy_hash: m.policy_hash, policy: policyObj };
      patch({ policy: p, pending: 'policy', done: undefined });
      const wallet = await w.wallet();
      const signed = await signMessage(wallet, { message: m.message, recipient: 'fuse', nonce, callbackUrl, state: 'fuse-policy' });
      return signed ? finishPolicy(signed, p) : undefined; // undefined: the wallet redirected, the answer arrives in the URL
    },
    onError: () => patch({ pending: undefined }),
  });
  const noSignMessage = policy.isError && (policy.error as Error).message === 'NO_SIGN_MESSAGE';

  // ---- back from a browser wallet ----
  const returned = useRef(false);
  const [returnError, setReturnError] = useState<string | null>(null);
  useEffect(() => {
    if (returned.current) return; returned.current = true;
    const r = readReturn(); if (!r) return;
    const draft = load();
    if (r.errorCode) { setReturnError(`The wallet did not sign: ${r.errorMessage ?? r.errorCode}.`); patch({ pending: undefined }); return; }
    if (r.txHashes?.length && draft.pending && draft.pending !== 'policy') { const k = draft.pending; patch(x => ({ tx: { ...x.tx, [k]: r.txHashes![0]! }, pending: undefined })); }
    if (r.signed && draft.pending === 'policy' && draft.policy) void finishPolicy(r.signed, draft.policy);
  }, [patch, finishPolicy]);

  const go = (s: Step) => { patch({ step: s }); window.scrollTo({ top: 0 }); };
  const bridgeDown = info.isError && isNotAvailable(info.error);
  const canContinue: Record<Step, boolean> = { 1: !!w.accountId, 2: !!chip, 3: !!d.tx.wallet && !!d.tx.agent, 4: !!d.saved, 5: !!d.done?.ok };

  return (
    <Page>
      <div className="wrap pt-6 pb-10 sm:pt-12">
        <h1 className="text-[36px] sm:text-[48px] text-ink">Set up your Fuse</h1>
        <p className="lead mt-3 max-w-[600px]">Five steps. Your wallet creates the two accounts and signs the chip's policy. The bridge stores names, never keys.</p>
        <div className="mt-8"><Rail step={d.step} /></div>
        {bridgeDown && <Note>The bridge is not reachable right now; chip and bridge steps will fill in when it is back.</Note>}
        {returnError && <Err>{returnError}</Err>}

        <section className="mt-10 max-w-[640px]" aria-live="polite">
          {/* 1 wallet */}
          {d.step === 1 && (
            <div>
              <h2 className="text-[26px] text-ink">Connect your wallet</h2>
              <Note>This is the owner: it funds the accounts, sets the policy, and can pause or withdraw at any time.</Note>
              <div className="mt-5 flex items-center gap-2" role="radiogroup" aria-label="Network">
                {(['testnet', 'mainnet'] as const).map(n => (
                  <button key={n} type="button" role="radio" aria-checked={d.network === n} className={`btn-quiet ${d.network === n ? '!border-ink !bg-surface' : ''}`} onClick={async () => { if (d.network !== n) { await w.disconnect().catch(() => {}); patch({ network: n, owner: undefined, tx: {}, saved: false, done: undefined }); setNetPicked(true); } }}>{n}</button>
                ))}
                {d.network === 'mainnet' && <span className="text-[13px] text-amber">real NEAR</span>}
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-4">
                {w.accountId ? (
                  <><span className="text-[15px]">Connected as <span className="mono text-[14px] text-ink">{w.accountId}</span></span><button type="button" className="link text-[14px] bg-transparent" onClick={() => void w.disconnect()}>Disconnect</button></>
                ) : (
                  <button type="button" className="btn-cta" disabled={!w.ready} onClick={() => void w.connect()}>{w.ready ? 'Connect wallet' : 'Loading wallets…'}</button>
                )}
              </div>
              {w.error && <Err>{w.error}</Err>}
            </div>
          )}

          {/* 2 chip */}
          {d.step === 2 && (
            <div>
              <h2 className="text-[26px] text-ink">Plug the chip in</h2>
              {chip ? (
                <div className="mt-4 space-y-1.5 text-[15px]">
                  <p>Chip connected · <span className="mono text-[14px]">{short(chip.pubkey, 10)}</span>{chip.fw_sha256 && <> · firmware <span className="mono text-[14px]">{chip.fw_sha256.slice(0, 8)}</span></>} · <span className="mode">{chip.mode.toLowerCase()}</span></p>
                  {chip.owner_pubkey ? <p className="text-amber">This chip is already owned by <span className="mono text-[14px]">{short(chip.owner_pubkey, 8)}</span>. Sign with the wallet that holds that key, or the chip will refuse the policy.</p> : <p className="text-ink-2">No owner yet: the first policy you sign binds your wallet's key to it.</p>}
                  {chip.mode === 'SIMULATED' && <p className="text-ink-2">This is the software simulator, labelled as such everywhere.</p>}
                </div>
              ) : (
                <Note>{bridgeDown ? 'Waiting for the bridge…' : 'Waiting for a chip on the serial port. Plug it in; this page checks every few seconds.'}</Note>
              )}
            </div>
          )}

          {/* 3 accounts */}
          {d.step === 3 && (
            <div className="space-y-10">
              <div>
                <h2 className="text-[26px] text-ink">Create the two accounts</h2>
                <Note>Both are sub-accounts of <span className="mono text-[14px] text-ink">{owner || '…'}</span>. The wallet contract holds the budget; the agent account is born with the chip's key as its only key.</Note>
                <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <label className="block text-[14px]">Wallet contract<input className="field mt-1.5 mono text-[14px]" value={d.wallet} onChange={e => patch({ wallet: e.target.value.trim() })} spellCheck={false} />{d.wallet && walletProblem && <span className="block mt-1 text-[12px] text-red">{walletProblem}</span>}</label>
                  <label className="block text-[14px]">Agent account<input className="field mt-1.5 mono text-[14px]" value={d.agent} onChange={e => patch({ agent: e.target.value.trim() })} spellCheck={false} />{d.agent && agentProblem && <span className="block mt-1 text-[12px] text-red">{agentProblem}</span>}</label>
                  <label className="block text-[14px]">Vendors the agent may pay<input className="field mt-1.5 mono text-[14px]" value={d.receivers} onChange={e => patch({ receivers: e.target.value })} placeholder="api.example.testnet, seller.testnet" spellCheck={false} /><span className="block mt-1 text-[12px] text-ink-3">comma separated · empty means the agent can pay nobody until you change the policy</span></label>
                  <label className="block text-[14px]">Budget in the wallet (NEAR)<input className="field mt-1.5" inputMode="decimal" value={d.budget} onChange={e => patch({ budget: e.target.value })} /><span className="block mt-1 text-[12px] text-ink-3">plus {info.data?.costs.wallet_storage_near ?? '2.9'} NEAR of contract storage</span></label>
                </div>
                <p className="mt-3 text-[13px] text-ink-3">{artifact.data ? <>Contract verified in your browser: {Math.round(artifact.data.code.byteLength / 1024)} KB · sha256 <span className="mono">{artifact.data.sha.slice(0, 16)}</span> matches the bridge.</> : artifact.isError ? <span className="text-red">Contract bytes could not be verified: {errorMessage(artifact.error)}</span> : artifactMeta?.missing ? <span className="text-red">The bridge has no built contract artifact.</span> : 'Fetching and hashing the contract…'}</p>
              </div>

              {([
                ['wallet', `A · ${d.wallet || 'wallet contract'}`, txFor('wallet'), !walletProblem && !agentProblem && !!artifact.data && !!walletDeposit],
                ['agent', `B · ${d.agent || 'agent account'}`, txFor('agent'), !walletProblem && !agentProblem && !!agentDeposit],
                ['registry', `C · point the wallet at the refusal registry (optional)`, txFor('registry'), !!d.registry && !!d.tx.wallet],
              ] as const).map(([kind, title, t, ready]) => (
                <div key={kind} className={kind === 'registry' && !d.registry ? 'hidden' : ''}>
                  <h3 className="text-[18px] text-ink">{title}</h3>
                  {t ? <ol className="mt-2 list-decimal pl-5 text-[14px] text-ink-2 space-y-0.5">{describeActions(t.actions, t.receiverId, near).map(l => <li key={l}>{l}</li>)}{kind === 'wallet' && <li>Initialise it: owner {owner}, agent {d.agent}, chip key {chip ? `${chip.pubkey.slice(0, 14)}…${chip.pubkey.slice(-6)}` : '…'}, pays only {receivers.join(', ') || 'nobody'}, 1 NEAR per payment, 3 NEAR per day</li>}{kind === 'registry' && <li>Registry: <span className="mono">{d.registry}</span></li>}</ol> : <Note>{chip ? 'Fill in the names above.' : 'Plug the chip in first.'}</Note>}
                  <div className="mt-3 flex flex-wrap items-center gap-4">
                    {d.tx[kind] ? (
                      <span className="text-[14px] text-accent-deep">Done · <a className="link" href={explorerTx(d.network, d.tx[kind]!)} target="_blank" rel="noreferrer">{short(d.tx[kind]!, 8)} ↗</a></span>
                    ) : (
                      <button type="button" className="btn-cta" disabled={!ready || !t || sign.isPending || !w.accountId} onClick={() => sign.mutate(kind)}>{sign.isPending && sign.variables === kind ? 'Waiting for the wallet…' : 'Sign with wallet'}</button>
                    )}
                    {kind === 'registry' && !d.tx.registry && <button type="button" className="link text-[14px] bg-transparent" onClick={() => patch({ registry: '' })}>skip</button>}
                  </div>
                </div>
              ))}
              {sign.isError && <Err>{errorMessage(sign.error)}</Err>}
              {d.tx.wallet && d.tx.agent && <Note>Both accounts exist: <a className="link" href={explorerAccount(d.network, d.agent)} target="_blank" rel="noreferrer">{d.agent}</a> has exactly one key, the chip's, limited to {methods.join(', ')} on {d.wallet}.</Note>}
            </div>
          )}

          {/* 4 bridge */}
          {d.step === 4 && (
            <div>
              <h2 className="text-[26px] text-ink">Tell the bridge</h2>
              <Note>The bridge on this machine switches to these accounts at once and remembers them in <span className="mono text-[14px]">bridge/data/config.json</span>.</Note>
              <dl className="mt-5 grid grid-cols-[140px_1fr] gap-y-1.5 text-[14px]">
                {([['network', d.network], ['owner', owner], ['wallet contract', d.wallet], ['agent account', d.agent], ['registry', d.registry || '(none)']] as const).map(([k, v]) => <div key={k} className="contents"><dt className="text-ink-3">{k}</dt><dd className="mono text-ink">{v}</dd></div>)}
              </dl>
              <div className="mt-5 flex flex-wrap items-center gap-4">
                <button type="button" className="btn-cta" disabled={save.isPending || !owner || !d.wallet || !d.agent} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : d.saved ? 'Save again' : 'Save to the bridge'}</button>
                {d.saved && <span className="text-[14px] text-accent-deep">Saved.</span>}
              </div>
              {save.isError && <Err>{isNotAvailable(save.error) ? 'The bridge is not reachable.' : errorMessage(save.error)}</Err>}
              {save.data?.effective && <p className="mt-3 text-[13px] text-ink-3">Bridge now: {Object.entries(save.data.effective).map(([k, v]) => `${k}=${v || '∅'}`).join(' · ')}</p>}
            </div>
          )}

          {/* 5 policy */}
          {d.step === 5 && (
            <div>
              <h2 className="text-[26px] text-ink">Sign the chip's policy</h2>
              <Note>Your wallet signs a NEP-413 message; the chip verifies it with your owner key, waits for a press on BOOT, and stores the policy in its flash.</Note>
              <ol className="mt-4 list-disc pl-5 text-[14px] text-ink-2 space-y-0.5">
                <li>Signer {d.agent} may only call {d.wallet}: {methods.join(', ')}</li>
                <li>Pays only {receivers.join(', ') || 'nobody'} · 1 NEAR per payment · your thumb above 0.5 NEAR</li>
                <li>At most 20 signatures per 10 minutes · gas cap 300 Tgas · no cross-chain destinations</li>
              </ol>
              {(preview.data ?? d.policy) && <p className="mt-3 text-[13px] text-ink-3">Message your wallet will sign (NEP-413, recipient <span className="mono">fuse</span>, seq {(preview.data ?? d.policy)!.seq}): <span className="mono break-all">{(preview.data ?? d.policy)!.message}</span></p>}
              {preview.isError && <p className="mt-3 text-[13px] text-amber">{isNotAvailable(preview.error) ? 'The bridge is not reachable; the message will be fetched when you sign.' : errorMessage(preview.error)}</p>}
              <div className="mt-5 flex flex-wrap items-center gap-4">
                <button type="button" className="btn-cta" disabled={policy.isPending || !w.accountId || !chip || countdown !== null} onClick={() => policy.mutate()}>{policy.isPending && countdown === null ? 'Waiting for the wallet…' : d.done?.ok ? 'Sign again' : 'Sign the policy with your wallet'}</button>
                {countdown !== null && <span className="text-[15px] text-amber">Press BOOT on the chip now · {countdown} s</span>}
              </div>
              {noSignMessage && <div className="mt-4 text-[14px] text-ink-2"><p className="text-red">This wallet cannot sign messages (NEP-413).</p><p className="mt-1">Save the policy and load it from the bridge machine instead:</p><pre className="mt-2 rounded-[12px] border border-line bg-surface p-3 text-[13px] overflow-x-auto">npm run fuse -- policy set policy.json --nep413</pre><button type="button" className="link text-[14px] bg-transparent mt-2" onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(policyObj, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'policy.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Download policy.json</button></div>}
              {policy.isError && !noSignMessage && <Err>{errorMessage(policy.error)}</Err>}
              {d.done && (
                d.done.ok ? (
                  <div className="mt-5 text-[15px]"><p className="text-accent-deep">The chip accepted the policy.</p><p className="mt-1 text-ink-2">Hash <span className="mono text-[14px]">{d.done.policy_hash}</span> · seq {d.done.policy_seq} · owner {short(d.done.owner_pubkey ?? '', 8)}</p><p className="mt-3">Your Fuse is set up. <Link to="/live" className="link">See it live →</Link></p></div>
                ) : (
                  <div className="mt-5 text-[14px] text-ink-2">
                    {d.done.code === 'OWNER_SIG_INVALID' && <><p className="text-red">The chip rejected the owner signature.</p><p className="mt-1">Firmware older than the NEP-413 update does not verify wallet signatures yet, and a chip that already has an owner only accepts that owner's key. Reflash, or load the policy from the bridge machine:</p><pre className="mt-2 rounded-[12px] border border-line bg-surface p-3 text-[13px] overflow-x-auto">npm run fuse -- policy set policy.json --nep413</pre></>}
                    {d.done.code === 'BUTTON_TIMEOUT' && <p className="text-red">No press within 30 seconds. Sign again and press BOOT when the LED blinks amber.</p>}
                    {d.done.code !== 'OWNER_SIG_INVALID' && d.done.code !== 'BUTTON_TIMEOUT' && <p className="text-red">{d.done.detail ?? d.done.error ?? d.done.code ?? 'The chip did not accept the policy.'}</p>}
                  </div>
                )
              )}
            </div>
          )}
        </section>

        <div className="mt-12 flex items-center gap-4 max-w-[640px]">
          {d.step > 1 && <button type="button" className="btn-quiet" onClick={() => go((d.step - 1) as Step)}>Back</button>}
          {d.step < 5 && <button type="button" className="btn-cta" disabled={!canContinue[d.step]} onClick={() => go((d.step + 1) as Step)}>Continue</button>}
          <button type="button" className="ml-auto link-quiet text-[13px] bg-transparent" onClick={() => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } setD(EMPTY); setNetPicked(false); }}>Start over</button>
        </div>
      </div>
    </Page>
  );
}
