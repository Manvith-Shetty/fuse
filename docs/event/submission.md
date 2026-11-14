# Submission checklist (from HACKATHON.md, read 2026-11-13; re-fetch before submitting)

Deadline: 2026-11-14 23:59 UTC (15 Nov 05:29 IST). One submission per repo. One attempt.

## Before submitting
- [x] Repo public, LICENSE present, README has "do X, see Y" steps for the simulator path and the hardware path.
- [ ] Demo video recorded (backup recorded early).
- [ ] X post published by the human: says built at NEAR HACKATHON, tags `@NEARProtocol` and `#NEARHackathon`
      (optional `@NearLegion` `@NearBuilders`), video attached. Copy the post URL.
- [ ] Mainnet payout account exists (e.g. `yourname.near`).
- [x] `docs/claims-ledger.md` is complete and honest.
- [x] Cold clone of the public repo on a clean machine: install, offline story, 21 bridge tests all pass (2026-11-14 12:30 UTC).

## Payload (exact fields; `website` is a spam trap, never include it)
```json
{
  "requestId": "<uuid generated once; reuse on retries>",
  "projectName": "Fuse",
  "leadName": "<human>",
  "email": "<human>",
  "size": "1",
  "tracks": ["security", "agents", "open"],
  "nearAddress": "<mainnet account>",
  "projectUrl": "https://github.com/Manvith-Shetty/fuse",
  "demoUrl": "https://x.com/<user>/status/<id>",
  "idea": "<20-2000 chars: problem, product, how NEAR fits>",
  "consent": true
}
```
`POST https://nearhackathon.com/api/applications`, `Content-Type: application/json`, body under 12000 bytes.
Generate requestId with `uuidgen | tr A-Z a-z`. Print the payload, get an explicit yes, then send.

| Status | Meaning | Action |
| --- | --- | --- |
| 201 | saved | done |
| 400 | field invalid | fix listed fields, resend with same requestId |
| 403 | window closed or cross-site | stop, tell the human |
| 409 | repo already submitted or email at 2 submissions | stop; fixes go via request-changes |
| 413 | body too large | shorten idea |
| 503 | storage down | wait a minute, resend same requestId |

Mistakes after a 201: https://nearhackathon.com/request-changes (never resubmit).

## Idea text (final, 1953 chars, 2026-11-14)
Problem: agents now pay for API calls, data and compute. Today an agent either cannot pay, or it holds a wallet file that one poisoned web page can drain. Software spending guards check the payment in the agent's process or in a contract, but the key still lives on the machine the agent runs on, so a compromised host can sign around the check or take the key.

Fuse gives an agent a budget, not keys. The agent's NEAR account holds exactly one key, generated on an ESP32-S3 and never exported; a function-call access key scopes it to one wallet contract and three methods at the protocol level. The chip decodes every transaction's raw bytes itself, never trusting the laptop that relays them, enforces receiver and token allowlists and caps, asks for a button press above a threshold and a second chip above a quorum, and signs a refusal receipt for every payment it stops. The wallet contract verifies and stores the receipt and forwards it to a shared registry other agents consult before paying anyone. The policy is owner-signed (NEP-413) and enforced three times: protocol, silicon, contract. Unplug the chip and the agent is revoked.

Claude Code uses it through one MCP tool: fuse_fetch reads an HTTP 402 price, checks the counterparty, has the chip sign, and redeems the API call with the chain receipt as proof. No vendor accounts or API keys. A red-team page lets anyone try to talk the agent into paying an attacker. Through Chain Signatures the same chip approves payments on Ethereum and Bitcoin.

Proven on testnet with the real chip: payment CxpuNBs7, button-gated payment AnP5Q2Zz, refusal receipts #17-19 stored onchain and forwarded to the registry (AEDpx3pH), MCP purchase 2HFVg7zi, quorum payment parked then approved by a second signer. 16/16 attacks stopped, 0/50 legitimate payments refused, 150 tests. Every README claim is labelled real chip, simulator or unverified; one offline command reproduces the demo without hardware.
