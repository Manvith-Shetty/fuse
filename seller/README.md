# seller: a pay-per-call API that trusts only the chain

The demo marketplace's seller side. The agent pays through the Fuse chip, then calls the service with the NEAR
transaction hash. The seller reads that transaction from the RPC and serves the data only if the wallet contract's
`pay` event in it names this seller, the amount covers the catalog price, the transfer result is `ok`, and the hash
has not been redeemed before. No account, no API key, no trust in the agent or the bridge.

```sh
cd seller && npm i
SELLER_ACCOUNT=api.fuse-hack-2026.testnet WALLET_CONTRACT=fuse.fuse-hack-2026.testnet npm start
#   see: [fuse-seller] api.fuse-hack-2026.testnet on http://127.0.0.1:7779
curl http://127.0.0.1:7779/                                           # catalog with prices
curl "http://127.0.0.1:7779/service/weather?city=Bengaluru"           # 402 payment required
curl "http://127.0.0.1:7779/service/weather?tx=<hash>&payer=agent-s3.fuse-hack-2026.testnet"
#   see: {"paid":{...,"explorer":"https://testnet.nearblocks.io/txns/<hash>"},"data":{...}}   (second call: 409 already redeemed)
```

The agent does this automatically when `SELLER_URL=http://127.0.0.1:7779` is set (see `agent/`). The data served is
labelled DEMO DATA; the payment verification is real.

## The 402 contract (what any vendor implements to charge Fuse agents)
1. Answer an unpaid request with HTTP `402` and a JSON body: `{"error":"payment required","pay":{"receiver":"<your NEAR account>","token":"near","amount":"<yoctoNEAR>"}, "then":"GET <same path>?tx=<hash>&payer=<account>"}`.
2. When the request comes back with `tx` and `payer`, read the transaction from the RPC (`tx` method), find the wallet
   contract's `EVENT_JSON` `pay` event whose `receiver` is you and whose `amount` covers the price, and a `pay_result`
   event with `ok: true`; refuse hashes you have already served.
3. Serve the data. Optionally pin `WALLET_CONTRACT` so only payments through a specific Fuse wallet count.
That is all. The agent side is `fuse_fetch` (MCP) or `fetch_paid_api` (agent tool).
