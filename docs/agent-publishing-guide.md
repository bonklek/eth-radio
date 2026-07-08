# Agent Publishing Guide

This guide is for agents operating Radio Free Ethereum publishing work. It is a
GitHub-facing document: use repo-relative paths only, never committed local
absolute paths, private RPC URLs, keys, wallet details, or operator-specific
machine state.

Local handoff bundles are temporary operator context. If a handoff provides
assets from a local machine, copy or install the required files into the
repo-relative locations below before running preview, compositor, or publishing
flows.

## Current Status

Implemented in this repo:

- Media segmentation to AV1/Opus WebM via `scripts/segment-av1-webm.mjs`.
- Incremental live segment generation via `scripts/live-segment-av1-webm.mjs`.
- Segment publishing via `scripts/publish-live-segments.mjs`.
- Pipelined publishing via `scripts/publish-live-segments-pipelined.mjs`.
- Blob/chunk publishing via `scripts/publish-blob-chunk.mjs`.
- Cost preflight support for publish flows.
- Preview and inspection routes in `scripts/serve-live-demo.mjs`, including
  `/overlay` and `/overlay-preview`.
- Reproducible resized overlay shell generation via
  `scripts/generate-rfe-overlay-assets.mjs`.

Still needed or in progress:

- A production compositor that burns the terminal overlay and live metadata into
  each slot-aligned segment before publishing.
- A production command that takes raw/avatar footage plus live proof metadata
  and emits already-overlaid segment payloads ready for blob publishing.

Until that compositor exists, do not run a public or hackathon publish that
requires a burned-in overlay. First generate a local segment and play that
segment directly to prove the overlay is inside the video pixels.

Do not describe raw-video publishing as complete broadcast overlay publishing.
`scripts/segment-av1-webm.mjs` segments an already-composited input. It does not
create or burn in the overlay by itself.

## Core Model

The published blob payload must be the composited video, not raw avatar footage
and not a browser/player UI.

Live publishing pipeline:

1. Start the pipelined publisher first, watching an initially empty segment
   output directory.
2. Read source/avatar video frames for one slot-aligned segment.
3. Select the terminal shell PNG matching the output profile.
4. Clear dynamic regions.
5. Render live metadata for that segment.
6. Composite source frames and terminal shell into final frames.
7. Encode that segment as AV1/Opus WebM.
8. Atomically write the segment file and update the segment manifest entry.
9. Let the already-running publisher publish the stable segment immediately.

Offline sample pipeline:

1. Produce an already-composited full video or short sample.
2. Use `scripts/segment-av1-webm.mjs` only to cut that composited input into
   WebM chunks.

For live publishing, prefer the first architecture. The compositor should emit
final segment files directly, and the publisher should consume those files. If a
downloaded or reconstructed segment is played by itself, the overlay must
already be visible in the decoded video pixels.

Do not pre-segment a full long video before starting the publisher. Full-stream
pre-work is allowed only for cost estimation with `--stream-duration-ms` or
`--expected-segments`; actual segment files must arrive one sequence at a time
while the publisher is already watching.

## Portable Assets

Canonical source assets:

- `public/rfe-assets/rfe-terminal-final.png`
- `public/rfe-assets/rfe-style-tokens.json`

Committed generated profile shell assets:

| Profile | Width | Height | Overlay asset | Notes |
| --- | ---: | ---: | --- | --- |
| `360p` | 640 | 360 | `public/rfe-assets/overlays/rfe-terminal-360p.png` | Low-cost preview/smoke profile. |
| `420p` | 746 | 420 | `public/rfe-assets/overlays/rfe-terminal-420p.png` | Nearest even width to 16:9 at 420px height. |
| `480p` | 854 | 480 | `public/rfe-assets/overlays/rfe-terminal-480p.png` | 16:9 rounded to an even encoder-safe width. |
| `720p` | 1280 | 720 | `public/rfe-assets/overlays/rfe-terminal-720p.png` | Higher-quality preview profile. |
| `1080p` | 1920 | 1080 | `public/rfe-assets/overlays/rfe-terminal-1080p.png` | Source-resolution profile. |

The source shell may be authored at `1920x1080`, but the compositor must not
blindly use a 1080p overlay for every stream. Select the profile shell that
matches the encoded output profile, or generate/cache the matching asset before
encoding.

The preview server serves these profile shells from `/rfe-assets/overlays/...`.
`/overlay` and `/overlay-preview` can select a shell with `profile`, `width`,
and `height` query parameters; local video preview also switches after video
metadata reveals the source dimensions.

Regenerate profile shells:

```powershell
node scripts/generate-rfe-overlay-assets.mjs
```

The generator validates that the source shell is a `1920x1080` PNG with alpha
and that each generated profile shell has the expected dimensions and alpha.

Verify shell dimensions:

```powershell
powershell -NoProfile -Command "Add-Type -AssemblyName System.Drawing; Get-ChildItem public/rfe-assets/overlays/*.png | ForEach-Object { $img=[System.Drawing.Image]::FromFile($_.FullName); [PSCustomObject]@{Name=$_.Name;Width=$img.Width;Height=$img.Height;Format=$img.PixelFormat}; $img.Dispose() }"
```

Generated segments, manifests, sidecars, reconstructed media, and live-run state
belong under ignored `work/` directories and should not be committed.

## Profile Matrix

Use this matrix as a starting point, not as a fixed product requirement.
Operators tune cadence, bitrate, blob cap, and cost budget together.

| Profile | FPS | Segment candidates | Starting video bitrate | Audio | Max blobs / bytes |
| --- | ---: | --- | --- | --- | --- |
| `360p` | 24 | `12000`, `24000`, `36000`, `48000` ms | `260k`-`420k` | Opus `32k` | Start at `6` / `761856`. |
| `420p` | 24 | `12000`, `24000`, `36000`, `48000` ms | `300k`-`520k` | Opus `32k` | Start at `6` / `761856`. |
| `480p` | 24 | `12000`, `24000`, `36000`, `48000` ms | `420k`-`700k` | Opus `32k`-`48k` | Start at `6` / `761856`. |
| `720p` | 24 | `24000`, `36000`, `48000` ms | `800k`-`1400k` | Opus `48k` | Tune with preflight. |
| `1080p` | 24 | `36000`, `48000` ms | Operator-tested only | Opus `48k`+ | Tune with preflight. |

Default codec is AV1 video plus Opus audio in WebM. Preserve audio unless the
operator explicitly approves a no-audio test.

## Metadata Semantics

The overlay is a broadcast proof layer, not a viewer control layer. The network
label must come from the actual `CHAIN` being used for publish, not from static
design copy.

Pre-publish fields that can be rendered into segment `N`:

- UTC generation clock.
- Network label.
- Proof block or proof slot from recent chain context.
- Proof/nonce value from that proof context.
- Current sequence.
- Current payload byte size.
- Current payload/content hash.
- Previous segment hash.
- Previous segment transaction hash.

Post-publish fields that cannot be rendered into the same segment:

- Segment `N` transaction hash.
- Segment `N` inclusion block or inclusion slot.
- Blob sidecar metadata that is only known after inclusion.

Do not render a segment's final transaction hash into that same segment before
publishing. The transaction hash depends on the blob payload bytes, and the
payload bytes would change if the hash were drawn into the segment.

Mandated visible transaction label: `PREV TX` or `LAST TX`. For segment `N`, it
means the confirmed transaction hash for segment `N - 1`. Do not use a bare
`TX` label unless the design has no room and the surrounding guide or code still
defines it as previous transaction.

Distinguish proof context from inclusion context:

- `PROOF SLOT` or `PROOF BLOCK` is sampled before or during generation and can
  be burned into the current segment.
- `INCLUSION SLOT` or `INCLUSION BLOCK` is discovered after publish and belongs
  in later telemetry, watcher UI, or the next segment's previous-state fields.

## Dynamic Regions

Treat terminal shell PNGs as visual shell art only.

- Production profile shell assets should not contain dynamic placeholder text.
- If placeholders remain in source art, clear them before drawing live values.
- Draw exactly one value per field.
- If two values appear stacked or ghosted, the clear region is wrong.
- Browser controls and debug panels are never part of the broadcast overlay.
- `rfe-terminal-final.png` and derived profile assets are not authoritative
  live data.

Before publishing, inspect generated overlay shells visually or with a pixel
check for baked dynamic values such as old clocks, tx hashes, payload sizes, or
content hashes. Clearing placeholder regions is a fallback; clean production
shell assets are preferred.

Dynamic region coordinates should be profile-specific token boxes or normalized
coordinates. If tokens are authored in 1080p source coordinates, scale boxes to
the target profile once, round to integer pixels, and use those rounded boxes
for clearing and text layout so repeated frames do not drift.

## Preview Surfaces

`/overlay` and `/overlay-preview` are preview/compositor sources. They are not
the final viewer UI.

The frontend/static watcher should play already-overlaid video chunks. It may
show extra controls, timelines, or debug data, but it should not be responsible
for drawing the proof overlay when the requirement is that the video itself
contains it.

Execution RPC is not enough for viewers: Station announcements come from
execution RPC logs, while blob bytes come from beacon API sidecars. Browser
watchers need CORS-capable execution and beacon endpoints if they reconstruct
directly.

## Compositor Workflow

No complete production compositor command exists yet in this repo.

Required compositor behavior:

1. Read source/avatar frames for the next segment interval.
2. Select the terminal shell matching the output profile.
3. Scale or load profile-specific dynamic-region token boxes.
4. Clear dynamic regions in the shell.
5. Render live metadata into those regions.
6. Composite source frames and shell into final frames.
7. Encode final frames into an AV1/Opus WebM segment.
8. Write the segment into the publisher watch directory.
9. Update the manifest entry for that sequence before moving to the next one.

Placeholder command shape for a future live compositor:

```powershell
node scripts/<compositor-script>.mjs `
  --input <source-video> `
  --out-dir <composited-segment-dir> `
  --stream-id <stream-id> `
  --profile <profile-name> `
  --segment-ms <slot-aligned-ms> `
  --network <network>
```

Offline/sample segmentation remains useful only when its input is already
composited:

```powershell
pnpm media:segment -- `
  --input <already-composited-video-input> `
  --out-dir <segment-output-dir> `
  --stream-id <stream-id> `
  --segment-ms <slot-aligned-ms> `
  --width <width> `
  --height <height> `
  --fps <fps> `
  --video-bitrate <bitrate> `
  --audio-bitrate <bitrate>
```

For raw or already-composited input tests where no burn-in compositor is being
used, use the incremental live generator instead of pre-segmenting the whole
input:

```powershell
pnpm live:segment -- `
  --input <already-composited-video-input> `
  --out-dir <segment-output-dir> `
  --stream-id <stream-id> `
  --segment-ms <slot-aligned-ms> `
  --width <width> `
  --height <height> `
  --fps <fps> `
  --video-bitrate <bitrate> `
  --audio-bitrate <bitrate> `
  --max-blobs <blob-cap> `
  --max-bytes <byte-cap> `
  --pace
```

`pnpm live:run -- --publish` is not the correct long live-stream path because
it segments first and publishes afterward.

## Cadence And Cost

Segment duration must be explicit and slot-aligned. Valid tuning candidates
include:

- `12000` ms
- `24000` ms
- `36000` ms
- `48000` ms

Tune cadence, bitrate, resolution, blob count, and pending depth together based
on operator goals for latency, quality, and cost. Do not reflexively lower
quality before considering cadence; do not change cadence without making that
tradeoff explicit.

The pipelined publisher currently defaults to `24000` ms because it is the more
conservative live starting point. `12000` ms is the aggressive low-latency
target and should be used only after local sample size checks, cost preflight,
and operator approval.

Watch these latency timings:

- Generated-to-submit.
- Submit-to-included.
- Generated-to-included.
- Sequence cadence against the configured segment duration.
- Pending queue depth.

## Publishing Commands

Serial publisher:

```powershell
pnpm live:publish -- `
  --dir <segment-output-dir> `
  --stream-id <stream-id> `
  --segment-ms <slot-aligned-ms> `
  --codec av1-opus/webm `
  --max-blobs <blob-cap> `
  --max-bytes <byte-cap> `
  --state <publish-state-file> `
  --max-cost-eth <operator-approved-budget>
```

Low-latency pipelined publisher:

```powershell
pnpm live:publish:pipelined -- `
  --dir <segment-output-dir> `
  --stream-id <stream-id> `
  --segment-ms <slot-aligned-ms> `
  --codec av1-opus/webm `
  --max-blobs <blob-cap> `
  --max-bytes <byte-cap> `
  --max-pending 2 `
  --adaptive-pending `
  --max-pending-max <operator-approved-pending-cap> `
  --state <publish-state-file> `
  --max-cost-eth <operator-approved-budget> `
  --stream-duration-ms <total-stream-duration-ms> `
  --require-manifest
```

Use the pipelined path when publishing segments as they are generated. Start it
before the live segment generator or compositor. It is expected to wait for
future manifest entries; that is healthy. It is not healthy for a generator to
wait until the full source video has been segmented before the publisher starts.

Use the serial path for simpler controlled runs or debugging. Higher
`--max-pending` or `--max-pending-max` can reduce gaps but increases outstanding
spend risk, so the cap must match the approved budget.

## Safety Checks

Before publishing:

- Confirm explicit operator approval to spend ETH.
- Verify no existing publisher process is running.
- Verify wallet balance.
- Verify `CHAIN`.
- Verify `ETH_RPC_URL`.
- Verify `BEACON_RPC_URL`.
- Verify `PRIVATE_KEY` presence only; never print it.
- Verify `STATION_ADDRESS`.
- Run cost preflight with explicit `--max-cost-eth`.
- Verify stream id and segment duration.
- Verify all sample segment sizes are below the blob payload guardrail.
- Verify the overlay is burned into a local sample segment.

Concrete non-secret checks:

```powershell
pnpm wallet:balance
pnpm live:publish -- --help
pnpm live:publish:pipelined -- --help
pnpm live:monitor -- --help
pnpm live:latency -- --help
```

Do not echo private environment values into logs or docs. Check that required
variables exist without printing their contents.

## Ordering And Verification

Canonical playback order is `streamId + sequence`. Block, transaction, and log
order are tie-breakers only.

Verification commands:

```powershell
pnpm blob:fetch -- --help
pnpm blob:reconstruct -- --help
pnpm live:monitor -- --help
pnpm live:latency -- --help
```

After publishing, reconstruct or download at least one segment and play it
directly outside the browser client. The overlay must be visible in that decoded
video file.

Stop publishing if:

- A duplicate sequence appears.
- A sequence is missing.
- Reconstructed payload hash does not match Station metadata.
- A generated or reconstructed segment lacks the burned-in overlay.

Recovery should resume from the last confirmed contiguous sequence for the
chosen `streamId`, not from block or transaction order.

## Agent Worktree Rule

Backend publishing agents must work only in their assigned backend publication
worktree and branch. Do not edit frontend/static client files, including
`public/decentralized`, unless explicitly instructed.

## Failure Modes

Oversized segment:

- Stop publishing.
- Treat cadence, bitrate, resolution, and blob count as explicit operator
  tradeoffs.
- Regenerate and verify sample segments before resuming.

Overlay missing from video:

- Stop publishing.
- Do not rely on `/overlay`, `/overlay-preview`, or the frontend player to fix
  the published artifact.
- Build or repair the compositor stage, regenerate composited segments, and
  verify them directly.

Duplicate or ghosted telemetry:

- Clear the affected dynamic region.
- Draw one live value.
- Re-check against the generated segment, not only the browser preview.

RPC read failure after a transaction lands:

- Do not blindly resend the same segment.
- Check the transaction receipt first.
- Repair or resume local state from the confirmed sequence if needed.
