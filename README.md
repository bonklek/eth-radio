# Radio Free Ethereum

Radio Free Ethereum is an Ethereum blob radio prototype: it publishes media
segments through an Ethereum Station contract and serves a browser tuner that
can verify and play those segments.

The repository keeps the Solidity contract, publishing utilities, and browser
client together in one package. Local media, generated state, credentials, and
private operator notes are intentionally ignored.

Version 0.2 consolidates the Station contract, browser viewer, publishing
utilities, shared protocol packages, and experimental publisher console. The
release intentionally excludes private planning, audit, checkpoint, and
workstream documents. Public viewer guidance is available from the documentation
pages in `public/decentralized/` and in the generated static client.

## Project Layout

- `contracts/Station.sol` - Station contract that records published stream
  segments and blob versioned hashes.
- `scripts/` - Local tooling for contract, media, publisher, and static-client
  workflows.
- `public/decentralized/` - Browser-only watcher intended for static hosting.
- `public/rfe-assets/` - Small tracked visual assets used by the live demo UI.
- `apps/publisher-console/` - Local publisher supervisor and operator GUI.
- `packages/protocol/` - Shared schemas, identifiers, schedule, availability,
  playback, constitution, and dependency-free browser slot math.
- `packages/economics/` - Bounded advisory client-planning fee snapshots,
  canonical fee-history estimates, capacity, and reservation quotes; never an
  authoritative auction oracle or fee-policy contract.
- `.env.example` - Configuration template. Copy it to `.env` locally and use a
  fresh low-value testnet key.

## Quick Start

Use Node.js 24 (the CI baseline; `package.json` supports Node 22.13 through 24)
and pnpm 11.7.0.
The static watcher does not require an `.env` file:

```powershell
pnpm install
pnpm web:serve
```

Open <http://127.0.0.1:8080/> while `pnpm web:serve` is running. The browser
connects directly to the configured execution and beacon endpoints, so those
endpoints must allow browser CORS requests. With no recent Station segments,
the expected initial state is an idle player while the blobspace feed continues
to update.

Custom execution, beacon, and archive URLs are browser-local configuration and
are never included in share URLs. This client accepts at most eight HTTP(S)
values per list and 2,048 UTF-8 bytes per value. Archive templates may use only
`{streamId}`, `{sequence}`, `{txHash}`, and `{payloadSha256}`; downloaded bytes
are accepted only after their exact expected length and SHA-256 digest match
Station metadata. Response bodies have a 12-second total read deadline in
addition to byte and chunk ceilings, so a provider cannot hold the viewer open
indefinitely after returning headers. The deadline uses the browser's monotonic
clock, so wall-clock corrections do not extend it. Changing the runtime configuration or
cancelling an archive operation also cancels any active body reader. URLs containing user information or any query parameters are
session-only: they remain available across reloads in the same tab but are
excluded from persistent browser configuration and share URLs. Other scripts
running at the same origin can still read session storage, so a local
credential-free proxy is the safer option for valuable provider credentials.
Cache-index exports omit full archive URLs, query strings, user information,
payload bytes, and internal write tokens. They retain only the archive origin
for transport provenance. Each export is limited to the currently tuned
chain, Station deployment, publisher, and stream identity; cached records from
other channels are not mixed into that document.
Verified archive records likewise persist only origin-level provenance. Database
version 7 clears older verified-media and metadata caches once because those
records may contain full resolved archive URLs; media can be verified and cached
again from current configuration.

A stream name is not a complete channel identity: different publishers may use
the same raw stream ID. A trusted share URL or saved favorite should therefore
include the publisher address, for example
`?stream=my-stream&publisher=0x…&station=0x…`. When a publisher is omitted, the
watcher may report discovered candidates, but it will not silently trust or
play one from a bounded recent-log scan. Paste an exact Station transaction or
choose a publisher-specific archive/favorite to establish the channel instead.
Browser configuration refuses stream IDs larger than the viewer decoder's
4,096-byte ABI-string ceiling. The same UTF-8 byte limit is enforced for shared
URLs, favorites, cached identity records, and decoded Station events. Oversized
shared identities stay invalid rather than being truncated or silently replaced
with a preset stream.
Favorites are chain-scoped as well as Station/publisher/stream scoped. The
chain-safe favorites schema uses a new local-storage namespace; ambiguous legacy
favorites without a chain ID are intentionally not guessed onto the currently
selected network and must be saved again.

The segment lookup accepts a transaction or blob hash, an explorer URL, or a
decimal block/sequence identifier. Pasted lookup text is capped at 2,048
characters, and decimal identifiers are capped at 78 digits before parsing;
larger input is rejected rather than partially extracting an embedded hash.

If a successful Station refresh removes or canonically replaces the segment
currently playing, the viewer stops it immediately and reports an interrupted
state. It does not continue presenting buffered orphaned bytes as live. The V1
client still relies on its documented bounded overlap scan and configured
providers; this behavior is not a claim of finalized-chain verification.
Displayed segment timestamps are fetched by the event's exact execution block
hash and cached under that hash, so a same-height replacement cannot reuse an
orphan timestamp. Beacon sidecar retrieval is not yet root-scoped and therefore
does not carry a stronger cross-layer verification claim.

Native media events are accepted only when the media element's active blob URL
belongs to the current verified record. Events and live-edge refresh continuations
from a superseded selection cannot pause, fail, or advance the newer selection.
Lookup, blob-slot, and segment-row verification also use one monotonic user-intent
token, so an older asynchronous verification cannot take over after a newer click.
Archive Watch actions have their own generation as well: selecting another archive
row invalidates prior verification context, and cache promotion, blobspace refresh,
and autoplay require the captured archive generation and runtime to remain current.
Saved-stream favorites create that generation before their preliminary log lookup,
so a slower earlier favorite cannot retune after a later favorite selection.
Compatible embedded RFE1 envelopes use the same 4,096-byte stream-ID ceiling as
Station decoding. If an envelope supplies `streamIdHash`, it must equal the
canonical hash of that stream ID; malformed claims are not silently discarded.

Routine RPC polling, buffering, and live-edge waiting update visible status
without repeatedly seizing screen-reader output. User-triggered outcomes,
canonical-history changes, and playback failures use dedicated deduplicated live
regions. Reduced-motion preferences disable repeated animation and smooth
scrolling.

Before startup completes, the application controls are inert and an explanatory
shell remains visible. Successful initialization unlocks the controls. If the
module never completes—or JavaScript is disabled—the shell states that chain
playback and verification are unavailable and provides a normal reload link.

Browser decode, media-network, unsupported-profile, and autoplay failures are
reported as local interrupted playback with an accessible retry message. They
do not silently relabel Station programming as fallback; native media controls
and segment play controls remain available for recovery.

For contract or publisher commands, copy `.env.example` to `.env` and replace
only the settings you need. The static watcher never reads the private key.
Never commit real credentials, and use a fresh low-value testnet key for local
publishing.

## Verification

Run the same complete gate used by CI before publishing changes:

```powershell
pnpm install --frozen-lockfile
pnpm check
```

The aggregate check covers syntax, text hygiene, formatting, lint, focused type
analysis, Station compilation and Cancun EVM behavior, deterministic static
build/artifact verification, production browser-client smoke tests, publisher
crash/budget safety, operator regressions, and a high-severity dependency audit.

## Common Commands

```powershell
pnpm station:compile
pnpm media:segment
pnpm web:build
pnpm web:static
pnpm web:serve
pnpm demo:live
pnpm publisher:console
pnpm test:publisher-console
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

Treat `dist/decentralized/` as disposable output, not as an authoritative
release source. Immediately before any static or IPFS handoff, run
`pnpm web:ipfs:prepare` (or at minimum `pnpm web:build` followed by
`pnpm web:static`) from the exact tracked revision being released. Never upload
an older directory left by a previous build.

The canonical public watcher is the browser-only static client in
`public/decentralized/`, built to `dist/decentralized/`. The Node live demo
serves that same viewer alongside local data APIs and overlay previews; it is
still a development server and must not be presented as the hosted watcher.
The static build inlines its explicitly allowlisted dependency-free protocol
kernel, so the artifact does not require a Node/package route at runtime.

## License

Licensed under the Viral Public License. See `LICENSE`.
