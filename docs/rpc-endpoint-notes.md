# RPC Endpoint Notes

The static client is a browser app, so endpoint reliability has two layers:

1. The provider must support the execution or beacon methods the app needs.
2. The provider must allow browser CORS requests from the deployed page.

Sepolia remains the active target until the static IPFS page can watch live
segments end to end. Mainnet presets exist for readiness only; use them after a
mainnet Station contract is deployed and tested.

## Current Presets

Sepolia execution:

- `https://sepolia.drpc.org`
- `https://ethereum-sepolia-rpc.publicnode.com`

Sepolia beacon:

- `https://ethereum-sepolia-beacon-api.publicnode.com`

Mainnet execution:

- `https://ethereum-rpc.publicnode.com`
- `https://eth-mainnet.g.alchemy.com/public`

Mainnet beacon:

- `https://ethereum-beacon-api.publicnode.com`

## Practice

- Keep endpoint lists user-editable in the static UI.
- Do not treat frontend API keys as secrets.
- Use public endpoints as defaults/fallbacks, but expect rate limits.
- For important streams, add a paid/provider endpoint that explicitly supports
  the required browser methods and CORS.
- Probe the exact methods: `eth_getLogs`, `eth_getTransactionByHash`,
  `eth_getBlockByHash`, `/eth/v1/beacon/genesis`, and
  `/eth/v1/beacon/blob_sidecars/{slot}`.
