# References (read these instead of guessing)

## Event
- Site: https://nearhackathon.com
- Rules file (re-fetch before submitting): https://nearhackathon.com/HACKATHON.md
- Submission form / request changes: https://nearhackathon.com/#apply , https://nearhackathon.com/request-changes
- Track prompts: https://github.com/nearai/near-hackathon-prompt-examples (copies in `docs/event/`)
- Public submissions API: `GET https://nearhackathon.com/api/projects?page=N`
- Free NEAR AI credits: https://nearbuilders.org/join then https://nearbuilders.org/dashboard

## NEAR protocol and tooling
- Docs index for agents: https://docs.near.org/llms.txt ; docs MCP: https://docs.near.org/mcp
- Agent skills: `npx skills add near/agent-skills` (https://github.com/near/agent-skills)
- Access keys (function-call key semantics and caveats): https://docs.near.org/protocol/accounts-contracts/access-keys
- Transaction lifecycle, signing = sha256(borsh(tx)): https://docs.near.org/integrations/transaction-lifecycle
- Borsh spec: https://github.com/near/borsh ; NEAR primitives (Transaction, Action): https://github.com/near/nearcore/tree/master/core/primitives
- near-api-js: https://docs.near.org/tools/near-api ; near-cli-rs: https://docs.near.org/tools/cli
- Testnet faucet: https://docs.near.org/getting-started/faucet ; RPC providers: https://docs.near.org/api/rpc/providers
- near-sdk (Rust): https://docs.near.org/smart-contracts/quickstart ; NEP-297 events; NEP-141 FT
- Chain Signatures: https://docs.near.org/chain-abstraction/chain-signatures and the implementation page; MPC repo https://github.com/near/mpc
  [VERIFY] testnet contract id (expected `v1.signer-prod.testnet`) and `sign` args / deposit

## NEAR AI Cloud
- Quickstart (OpenAI-compatible, `https://cloud-api.near.ai/v1`): https://docs.near.ai/cloud/quickstart
- Models: https://docs.near.ai/cloud/models
- Verification and response signatures: https://docs.near.ai/cloud/verification , https://docs.near.ai/cloud/verification/cloud-api/response-signatures
- Verifier example: https://github.com/near-examples/nearai-cloud-verification-example

## Competitors and prior art (cite in README)
- NEAR Intents Agent API (official hosted policy wallet): https://docs.agentsonintents.com/integration/agent-api/overview
- EspWarden (ESP32 Ethereum policy signer): https://github.com/sserrano44/EspWarden
- Ledger Agent Stack (agent proposes, human approves on device)
- arXiv 2610.21063 "Approve What, Exactly?" (approval attacks; why the device must parse bytes itself)
- arXiv 2605.26159 Device Context Protocol (device-side gating of LLM commands)

## Hardware
- PlatformIO ESP32: https://docs.platformio.org/en/latest/platforms/espressif32.html
- rweather Crypto (Ed25519, SHA256): https://github.com/rweather/arduinolibs
- ArduinoJson: https://arduinojson.org
- ESP-IDF random number generation (bootloader_random_enable): https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/system/random.html
- Wokwi ESP32 simulator (firmware testing before hardware arrives): https://wokwi.com
