# Decentralized Deployment Checklist

Use this checklist when publishing Radio Free Ethereum without a public backend.

## Public Components

- Station contract address, ABI, and deployment block.
- Static tuner source and pinned build output.
- Publisher source and blob encoding rules.
- Segment metadata emitted by the Station contract.
- Optional archive manifests that point to IPFS, Arweave, Filecoin, torrent, or
  community mirror payloads.

## Private Components

- Publisher private keys.
- RPC provider account credentials that are not intended for public browsers.
- Unreleased media and operational notes.
- Local cache contents unless the user explicitly exports or mirrors them.

## Runtime Requirements

- At least one browser-accessible execution RPC with CORS.
- At least one browser-accessible beacon REST API with CORS.
- For the current live-first Sepolia phase, archive mirrors are optional. Old
  segments may stop playing after blob sidecars fall out of normal availability.
- A static host or content-addressed network that can serve `index.html`,
  `styles.css`, and `app.js` unchanged.

## Verification Rules

- Station logs define the segment playlist.
- Blob sidecars and archive mirrors are untrusted byte sources.
- The browser must reconstruct bytes from blobs using the published 31-byte
  field-element packing rule.
- The browser must verify SHA-256 against Station metadata before playback.
- Cached media is trusted only because it was already verified locally.

## Mainnet Spend Guardrails

- Fund only a fresh low-balance hot wallet, never the real funding wallet key.
- Set `CHAIN=mainnet` and verify `pnpm wallet:balance` reports chain ID `1`.
- Spending scripts refuse mainnet unless
  `MAINNET_CONFIRM="I understand this spends real ETH"` is set.
- Start with `--once`, `--max-pending 1`, and a tiny segment before increasing
  duration or balance.

## Publish Flow

```powershell
pnpm web:build
pnpm web:static
```

Pin `dist/decentralized/` to the desired network. For DNS:

Prepare the IPFS publish metadata without pinning:

```powershell
pnpm web:ipfs:prepare
```

- IPFS: use DNSLink or a gateway CNAME.
- Arweave/Filecoin: point the domain or subdomain at the chosen gateway or
  resolver.
- ENS/IPNS: use it as a mutable pointer to the current content-addressed build.

After publishing, load the deployed page in a browser and confirm:

- execution endpoint health is `ok`
- beacon endpoint health is `ok`
- Station events appear
- at least one segment verifies
- playback uses a local `blob:` URL after verification
