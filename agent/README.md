# agent

NEAR AI Cloud agent (OpenAI-compatible, `cloud-api.near.ai`). Tool `pay(receiver, token, amount, memo)`
routed through the bridge. Timer loop that buys an API call on its own. Captures the response signature
(`/v1/signature/<id>`) and puts its hash in the payment memo. Includes the prompt-injection fixtures used
by `attacks/`.
