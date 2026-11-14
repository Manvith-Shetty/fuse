# Fuse frontend

The product site for Fuse, the hardware budget key for AI agents. One story: *give your agent a budget, not your keys.*
A chip holds the only key of the agent's NEAR account, decodes every transaction itself, refuses anything outside the
policy, asks for a thumb above a limit, and is revoked by pulling the cable.

Vite 7 + React 19 + TypeScript strict + Tailwind v4 (`@tailwindcss/vite`; tokens live in `@theme inline` in
`src/index.css`, paper/ink light by default and dark via `prefers-color-scheme`, one green accent). TanStack Query v5
for polling, one shared WebSocket for `/events`, Framer Motion only for the LED, the verdict word and the revoke
takeover, lucide-free, no UI kit. Fonts: Inter Tight (display), Inter (text), JetBrains Mono (hashes and ids).
Amounts are yoctoNEAR strings handled with `BigInt` only.

## Run

```sh
cd bridge && npm run fuse -- serve                     # bridge API on 127.0.0.1:7777 (real chip, or SIMULATE_CHIP=1)
cd agent  && npx tsx src/index.ts serve --port 7778    # red-team service
cd frontend && npm i && npm run dev                    # http://localhost:3000
```

`npm run typecheck`, `npm test` (Vitest), `npm run build` (writes `dist/`), `npm run preview` (serves `dist/` on :3000 with the same proxy).

## Proxy and env

`vite.config.ts` proxies `/api/bridge/*` to the bridge (prefix stripped, WebSocket for `/api/bridge/events`) and
`/api/agent/*` to the agent service (prefix stripped). Targets come from `.env` (copy `.env.example`):

| key | default | used by |
| --- | --- | --- |
| `VITE_BRIDGE_URL` | `http://127.0.0.1:7777` | dev/preview proxy target for `/api/bridge` |
| `VITE_AGENT_URL` | `http://127.0.0.1:7778` | dev/preview proxy target for `/api/agent` |

Only `VITE_*` keys reach the browser; `.env` is gitignored; every fetch goes through `src/lib/api.ts`. Anything the
bridge does not serve renders "not available" in a sentence; the UI never invents a number or a verdict.

## Pages

| path | what |
| --- | --- |
| `/` | Landing: hero, three beats, four live numbers (`/onchain`, `/status`, `/check?receiver=attacker.testnet`), "what it cannot do", footer |
| `/live` | The chip (LED derived from the event feed and heartbeat, mode, heartbeat, one-line policy), one action (pay 0.001 NEAR for the weather report) and "Inject attack", the last 8 events as sentences. Full-screen quiet takeover when the heartbeat dies |
| `/red-team` | Paste a poisoned document, the agent reads it, the chip decides; verdict as one word, the transcript behind a disclosure, three numbers |
| `/setup` | Five-step onboarding with the owner's wallet (wallet-selector: MyNearWallet, Meteor, HOT, Nightly): connect, chip, create `fuse.<owner>` and `agent.<owner>` (one transaction each, previewed before the wallet opens), save to the bridge, owner-signed chip policy (NEP-413 `signMessage`, then "press BOOT" with a 30 s countdown) |
| `/settings` | `GET /config` as a form, `POST /config` to switch the bridge |
| `/audit`, `/counterparty`, `/policy` | Judges' details behind the footer "Details" menu: one table each |

LED language: idle = dim green breathe, signed = green flash, refused = red flash, button = amber pulse, no heartbeat =
solid red (`src/lib/led.ts`). Verdict vocabulary everywhere: allow / warn / block. `HARDWARE` / `SIMULATED` is in the
nav and on every result.

## Setup wizard notes

- Browser wallets redirect away to sign; the draft lives in `localStorage` (`fuse.setup.v1`, names and tx hashes only,
  no secrets) and the URL return (`transactionHashes`, `errorCode`, NEP-413 `signature`) is read on load.
- The contract bytes come from `GET /api/bridge/artifacts/fuse_wallet_v2.wasm` and are hashed in the browser with
  WebCrypto against the sha256 the bridge reports in `/setup/info` before `DeployContract` is offered.
- A chip whose firmware predates NEP-413 answers `OWNER_SIG_INVALID`; the page says so and prints the CLI fallback
  `npm run fuse -- policy set policy.json --nep413` with a download of the exact policy.
- Wallet libraries expect Node globals; `src/main.tsx` provides `Buffer`, `global` and `process.env`.

## Tests

`src/lib/format.test.ts` (yocto formatting, NEAR to yocto, percentages), `src/lib/led.test.ts` (LED reducer),
`src/lib/sentences.test.ts` (event feed sentences, pairing refusals with their onchain receipts),
`src/lib/setup.test.ts` (account-name rules, deposits, the exact transactions the wizard asks the wallet to sign).

## Screenshots

`node screenshot.mjs http://localhost:3000[/route] [label]` saves `temporary screenshots/screenshot-N[-label].png`
(never overwritten). `WIDTH`/`HEIGHT` set the viewport, `SCHEME=dark` picks the dark theme (light is the default),
`FULL=0` disables full-page capture, `SETTLE_MS` adds wait time. Full-page captures scroll through the page first so
scroll-revealed sections are in view. The folder is gitignored.

## Layout

```
index.html            fonts, #root
public/favicon.svg    the board with its green LED
src/index.css         theme tokens, base, components (.btn-cta .btn-quiet .field .mode .tbl .reveal)
src/lib/              api.ts, types.ts, codes.ts, format.ts, led.ts, sentences.ts, setup.ts, wallet.ts, router.tsx
src/hooks/            events.tsx (WebSocket + /log seed, heartbeat, 3 s hysteresis), useBridge.ts (queries, useLed)
src/components/       Nav, Footer, Page, Chip (SVG board), Led, ModeBadge, VerdictWord, Reveal, Takeover
src/pages/            Landing, LivePage, RedTeamPage, SetupPage, SettingsPage, AuditPage, CounterpartyPage, PolicyPage
```
