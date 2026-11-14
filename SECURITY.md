# Security policy

Fuse is a hackathon prototype that holds testnet funds. Treat everything below as the current state, not a promise.

## What is in scope
- The firmware's decoder and policy engine (`firmware/lib/fusecore`): a transaction the chip signs outside its policy,
  a refusal receipt that verifies for bytes the chip never saw, a policy change accepted without the owner's signature.
- The wallet and registry contracts (`contracts/`): spending outside the onchain policy or daily cap, a refusal receipt
  stored without verifying, a quorum payment released without an approver, state lost in `migrate()`.
- The bridge's claim to hold no keys (`bridge/`): any path where a private key or seed reaches the bridge or the logs.
- The agent account's key scope: any way the function-call key can do more than the three methods on one contract.

## Known gaps, so you do not have to find them
- The development board has no Secure Boot, flash encryption or tamper detection; the key can be read with a flash
  dump and the firmware hash the chip reports is self-asserted. The production procedure is `docs/secure-boot.md`.
- The bridge is a local development server: it binds to localhost but has no authentication and open CORS, so any
  process on the same machine can propose payments. The chip and the contract bound what they can do.
- The shared registry accepts reports from anyone with a valid receipt; without trusted reporters a party running many
  chips can push a verdict to `block`. Storage is paid by the registry, so it can be flooded.
- The daily cap is per wallet, summed across tokens, not per token.
- `request_chain_sig` does not RLP-decode the EVM payload; the contract trusts the `to` and `value` the chip checked.
- The attested-decision path has not run against NEAR AI Cloud; only the simulator's labelled dev signer has exercised it.
- The contracts have unit tests but no external audit, and the builds are not reproducible yet.

## Reporting
Open a private security advisory on the GitHub repository, or an issue titled "security" if advisories are not
available. Include the transaction hash or the bytes involved. Expect an answer within a few days; this is one person
and a board.

## Not in scope
Prompt injection against the agent itself (the design assumes the agent is fooled), availability (unplugging the chip
stops the agent by design), the correctness of the agent's purchasing decisions within policy, and testnet faucet abuse.
