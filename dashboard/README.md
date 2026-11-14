# dashboard

Vite + React single page that shows what the Fuse chip is doing, live: heartbeat, event feed, the three
locks (protocol key, chip policy, contract policy), onchain payments and refusal receipts, and a form to
propose a payment or inject an attack. Shows a full-width **AGENT REVOKED** banner within about 2 s of the
chip being unplugged.

## Run
1. Start the bridge (it serves the API on 127.0.0.1:7777): `cd bridge && npm run fuse -- serve`
2. `cd dashboard && npm i && npm run dev` then open http://localhost:5173

The dev server proxies `/status`, `/log`, `/onchain`, `/pay`, `/chain-sig` and the `/events` websocket to
the bridge, so there is no CORS setup. Set `BRIDGE_URL` to point elsewhere.

`npm run build` type-checks and writes `dist/` (static files, no external scripts). Serve `dist/` behind
anything that proxies the same paths to the bridge.

The mode badge (HARDWARE / SIMULATED) comes from the chip itself and is always visible.
