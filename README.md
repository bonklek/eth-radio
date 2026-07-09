# Radio Free Ethereum

Radio Free Ethereum is an Ethereum blob radio prototype: it publishes media
segments through an Ethereum Station contract and serves a browser tuner that
can verify and play those segments.

The repository keeps the Solidity contract, publishing utilities, and browser
client together in one package. Local media, generated state, credentials, and
private operator notes are intentionally ignored.

## Project Layout

- `contracts/Station.sol` - Station contract that records published stream
  segments and blob versioned hashes.
- `scripts/` - Local tooling for contract, media, publisher, and static-client
  workflows.
- `public/decentralized/` - Browser-only watcher intended for static hosting.
- `public/rfe-assets/` - Small tracked visual assets used by the live demo UI.
- `.env.example` - Configuration template. Copy it to `.env` locally and use a
  fresh low-value testnet key.

## Quick Start

```powershell
pnpm install
Copy-Item .env.example .env
pnpm station:compile
pnpm web:build
pnpm web:static
```

Use `.env` for local settings. Never commit real credentials.

## Common Commands

```powershell
pnpm station:compile
pnpm media:segment
pnpm web:build
pnpm web:static
pnpm web:serve
pnpm demo:live
```

Tune command options with `--help` on the relevant script.

## Publishing Notes

Do not commit `.env`, generated `work/` contents, virtual environments, local
media PDFs, or dependency folders. The tracked files are the source and small
runtime assets needed to clone, install, compile, and run the demo.

Public releases must be produced from tracked source, a clean clone, `git
archive`, or the static build output in `dist/decentralized/`. Do not create a
GitHub release, source archive, IPFS upload, or copied release bundle by zipping
the full working directory: local `.env` files, `work/` state, generated media,
private RPC URLs, publisher state, private keys, and private notes are
operator-local only.

The canonical public watcher is the browser-only static client in
`public/decentralized/`, built to `dist/decentralized/`. The Node live demo is a
local development surface; do not present it as the hosted public watcher.

## License

Licensed under the Viral Public License. See `LICENSE`.
