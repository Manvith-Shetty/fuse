# agent

NEAR AI Cloud agent (OpenAI-compatible, `cloud-api.near.ai`). Tool `pay(receiver, token, amount, memo)`
routed through the bridge. Timer loop that buys an API call on its own. Captures the response signature
(`/v1/signature/<id>`) and puts its hash in the payment memo. Includes the prompt-injection fixtures used
by `attacks/`.

## v2 (docs/v2-spec.md)
- `npx tsx src/index.ts run --inject` still runs one task; the logic now lives in `src/core.ts` and returns typed events.
- `npx tsx src/index.ts serve` starts the red-team server on 127.0.0.1:7778: `POST /attempt {text, task?}` runs the agent
  with `text` as an untrusted document (one attempt at a time, 20 s cooldown, 4 KiB max) and records the chip's verdicts in
  `data/attempts.jsonl`; `GET /attempts` is the leaderboard (counts by refusal code, recent attempts with explorer links).
- Counterparty check: the agent has a `check_counterparty` tool backed by the bridge's `/check` (shared refusal registry).
- Attested decisions: with `NEAR_AI_API_KEY`, each completion's ed25519 response signature becomes a `decision` envelope
  sent with `pay`; a chip whose policy lists `decision_signers` refuses payments without one (labelled `DECISION_REQUIRED`).
- Pay-per-call: with `SELLER_URL=http://127.0.0.1:7779` the agent presents each paid transaction to the seller (`seller/`),
  which verifies it onchain before serving the data.
- Other frameworks: `src/tools/langchain.ts` (plain async functions + JSON schemas) and `src/tools/openai-schema.json`.
