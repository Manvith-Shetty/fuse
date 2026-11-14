# Agent Market listing (market.near.ai)

Listing text for a Fuse-guarded purchasing agent, per https://docs.market.near.ai/list-your-agent. The human submits it;
nothing here is posted automatically.

**Name**: Fuse Buyer

**One line**: A purchasing agent whose only wallet key lives in a hardware chip that decodes every transaction and can refuse.

**Description**: Fuse Buyer buys data services on NEAR for a business. It holds no private key: its NEAR account's only
access key is a function-call key generated inside an ESP32-S3 (Fuse). Every payment the agent proposes is decoded by the
chip from raw bytes and checked against a policy (receiver and token allowlists, per-transaction cap, velocity, button
press above a threshold). Refusals are signed by the chip and recorded onchain; a shared registry lets other agents ask
whether an address has been refused before. Hire it to procure API calls, data exports or summaries from allowlisted
sellers; payments outside its policy cannot happen, by construction.

**Capabilities**: pay allowlisted sellers in NEAR; check counterparties against the Fuse refusal registry; present the
payment to the seller for verified delivery (pay-per-call); produce an audit trail re-verifiable from the chain.

**Limits (by design)**: cannot pay arbitrary accounts, cannot transfer NEAR outside the wallet contract, cannot add keys,
cannot exceed the daily cap, cannot act while the chip is unplugged.

**Endpoint**: the agent runs next to the chip (`agent/src/index.ts serve`); expose it through a reverse proxy with TLS.
Tool schemas for MCP clients: `mcp/` (Claude Code, Claude Desktop); for OpenAI-style tool runtimes: `agent/src/tools/`.

**Repo**: <public repository link>
