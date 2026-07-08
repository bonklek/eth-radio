# Radio Free Ethereum

Radio Free Ethereum is an Ethereum blob radio prototype: it segments media,
publishes segment metadata through a Sepolia Station contract, reconstructs
payloads from blob sidecars, and serves a live web tuner from the same Node
workspace.

The repository keeps backend scripts, the Solidity contract, and the frontend
demo together in one package. Large local media, generated chain state, research
scratchpads, virtual environments, and copied external worktrees remain on disk
under ignored paths.

## Project Layout

- `contracts/Station.sol` - Station contract that records published stream
  segments and blob versioned hashes.
- `scripts/` - Node and Python tooling for deployment, blob publishing,
  media segmentation, reconstruction, monitoring, and the live demo server.
- `public/rfe-assets/` - Small tracked visual assets used by the live demo UI.
- `.env.example` - Configuration template. Copy it to `.env` locally and use a
  fresh low-value testnet key.

## Quick Start

```powershell
pnpm install
Copy-Item .env.example .env
pnpm station:compile
pnpm demo:live
```

The demo server defaults to `http://127.0.0.1:5173/`. Set `PORT`, `STREAM_ID`,
`ETH_RPC_URL`, and `BEACON_RPC_URL` in `.env` as needed.

## Common Commands

```powershell
pnpm station:compile
pnpm station:deploy
pnpm media:segment
pnpm live:publish:pipelined
pnpm live:monitor
pnpm demo:live
```

Tune the command options with `--help` on the relevant script for publishing
flows and health checks.

## Publishing Notes

Do not commit `.env`, generated `work/` contents, virtual environments, local
media PDFs, or dependency folders. The tracked files are the source and small
runtime assets needed to clone, install, compile, and run the demo.

### Cost Preflight

Publishing scripts can refuse to start if the projected stream cost exceeds an
operator budget:

```powershell
pnpm live:run -- --input .\video\test.mp4 --stream-id demo --publish --max-cost-eth 0.1
pnpm live:publish:pipelined -- --dir .\work\blob-radio-testnet\live-runs\demo\segments --stream-id demo --max-cost-eth 0.1
```

The estimate uses actual segment byte/blob counts when files already exist. For
a directory that is still being generated, pass either `--stream-duration-ms` or
`--expected-segments` so the preflight can project the full run. By default it
uses a `1.25x` safety multiplier and blocks on insufficient budget; use
`--cost-mode warn` only for an intentional override.

If `MAX_FEE_PER_GAS_GWEI` and `MAX_FEE_PER_BLOB_GAS_GWEI` are set, the preflight
estimates against those caps. Otherwise it queries `ETH_RPC_URL` for current
execution gas and blob base fee.

### Speed Tuning

Use the pipelined publisher for low-latency live tests:

```powershell
pnpm live:publish:pipelined -- --dir .\work\blob-radio-testnet\live-runs\demo\segments --stream-id demo --segment-ms 12000 --max-pending 2 --adaptive-pending --max-pending-max 4 --max-cost-eth 0.1
```

The pipelined state file records per-segment timing fields:
`firstSeenAt`, `generatedAt`, `submittedAt`, `includedAt`, plus
`timings.generatedToSubmitMs`, `timings.submitToIncludedMs`, and
`timings.generatedToIncludedMs`. Playback APIs sort stream segments by
`streamId`, then `sequence`, with block/transaction/log indexes only as
tie-breakers.

## License

Licensed under the Viral Public License. See `LICENSE`.
