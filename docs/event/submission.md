# Submission checklist (from HACKATHON.md, read 2026-11-13; re-fetch before submitting)

Deadline: 2026-11-14 23:59 UTC (15 Nov 05:29 IST). One submission per repo. One attempt.

## Before submitting
- [ ] Repo public, LICENSE present, README has "do X, see Y" steps for the simulator path and the hardware path.
- [ ] Demo video recorded (backup recorded early).
- [ ] X post published by the human: says built at NEAR HACKATHON, tags `@NEARProtocol` and `#NEARHackathon`
      (optional `@NearLegion` `@NearBuilders`), video attached. Copy the post URL.
- [ ] Mainnet payout account exists (e.g. `yourname.near`).
- [ ] `docs/claims-ledger.md` is complete and honest.

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
  "projectUrl": "https://github.com/<user>/<repo>",
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

## Idea text draft (edit before use)
Fuse gives an AI agent a NEAR wallet without giving it a key. The agent account holds one function-call
key generated on an ESP32 and never exported; the protocol scopes it to one contract and three methods.
The chip decodes every transaction's raw bytes, enforces allowlists and caps, requires a button press
above a threshold, and signs refusal receipts that are recorded onchain. Policy is enforced three times:
protocol, silicon, contract. Unplug the chip and the agent is revoked. Through Chain Signatures the same
chip approves payments on other chains. NEAR provides the key model, the onchain policy and evidence,
and the cross-chain signing.
