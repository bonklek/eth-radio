# RFE Publisher Console Prototype

This console is an experimental local publisher prototype. It is published for
review and testnet experimentation; it is not approved for unattended Mainnet
operation or production use. Its safety checks reduce operational risk but do
not turn the local process boundary into a hardware or operating-system sandbox.

## Run

From the repository root:

```powershell
node apps/publisher-console/launch.mjs
```

Open `http://127.0.0.1:8787`. The launcher detaches the supervisor, so closing
the browser tab does not stop an active job. Stop the supervisor explicitly:

```powershell
node apps/publisher-console/stop.mjs
```

The supervisor reads the repository-local `.env`, but worker processes do not
auto-load it. Children receive role-specific environment allowlists: media never
receives the signing key, send/beacon endpoints, unrelated cloud/ingest secrets,
fault controls, or `NODE_OPTIONS`; the publisher receives the signing key and
minimal host-runtime variables. Media and publisher use separate closed job
files. Media reads a public-safe count projection rather than transaction state;
publisher receives no source path or ingest URL. Both children still run as the
same OS user, so this is data minimization, not a sandbox against a compromised
worker. Use only a dedicated, low-value test wallet.

## Current prototype

- One source and one station at a time. Sources can be a local media file,
  continuous Windows desktop capture, or a live HTTP(S)/RTMP(S)/SRT/UDP URL.
- Sepolia/Mainnet selection with explicit Mainnet spend confirmation.
- Configurable AV1 profile, segment cadence, blob cap, pending window, runtime
  budget, per-segment exposure, fee ceilings, RPC fallbacks, and retry policy.
- Configurable burned-in terminal/lower-third/minimal overlay.
- Rolling file encoding with per-segment bitrate fallback. Encoding and
  publication run side by side; the encoder pauses at the configurable queue
  ceiling instead of preprocessing the entire file.
- Continuous live capture uses one persistent FFmpeg process and emits
  independently playable WebM segments. If the publishing queue fills, it
  keeps capture alive, records a dropped segment, and exposes that condition
  in the GUI.
- A current Ethereum block number/hash and UTC timestamp can be burned into
  the video pixels. Witness freshness is advisory: stale or unavailable RPC
  data is labeled and never rejects media or stops the transmission.
- Live setup includes full-desktop or coordinate-region capture, DirectShow
  audio-device discovery, a real source-frame preview, and an expiring
  preflight arm ticket. Any setting change disarms Start until source, RPC
  chain, station bytecode, wallet balance, and queue policy pass again.
- The header provides a persistent light/dark theme switch, while publishing
  network selection is the first transmission setting rather than a status
  decoration.
- Generated manifests and individual segment entries record the boolean
  `overlayBurnedIn` for replay-safety decisions.
- Concurrent use of the repository's crash-safe pipelined publisher.
- Durable job state, singleton supervisor lock, browser-independent runtime,
  restart recovery, pause, drain, immediate stop, log redaction, and confirmed
  segment cleanup.
- A durable publisher restart circuit: five exits inside ten minutes stop both
  workers in an operator-action-required failed state; a five-minute stable run
  resets the window. Exit causes and timestamps remain bounded in supervisor
  state instead of retrying deterministic signer/network faults forever.
- Service restart never auto-resumes an active job. A persisted running, paused,
  or draining intention becomes durable `recovery-required`; ordinary controls
  cannot resume it and a new job cannot start. The prior intention remains visible
  for future source/signer/chain/policy/lineage reconciliation rather than being
  interpreted as current spending authority.
- Supervisor shutdown is ordered: both managed children receive SIGTERM, retain
  twelve seconds for their own cleanup (longer than live capture's five-second
  FFmpeg grace), then receive SIGKILL only if still owned. The supervisor waits
  another two seconds and releases its singleton lock only after child exit is
  observed. Unconfirmed ownership writes `rfe/publisher-shutdown-ambiguity@1`,
  preserves the lock, and blocks immediate relaunch for operator reconciliation.
- Durable transaction-attempt lineages with same-nonce fee replacement,
  bounded bump policy, old-or-new winner reconciliation, endpoint-wide receipt
  checks, external nonce-consumption detection, and configurable confirmation
  depth before operational confirmation.
- Resume is reconciled before either media worker advances a cursor. Retained
  segment sequence/index, regular-file identity, byte length, SHA-256, partial
  artifacts, and untracked output are checked. Finite sources are bound by path,
  size, modification time, and full-file SHA-256. Only a contiguous prefix that
  attributed publisher progress reports confirmed may be absent after cleanup;
  every other discrepancy requires operator recovery.

## Reliability boundary

Pending exposure is calculated per nonce lineage: sibling replacements cannot
both execute, so the engine reserves the largest attempt in each lineage, then
sums those maxima across pending nonces. Every attempt hash remains eligible to
win until one receipt is canonical and has reached the configured confirmation
depth.

Immediately before every initial or replacement reservation, the engine queries
each available execution endpoint for the publishing account's `pending`
balance. The lowest responding balance must cover the entire proposed pending
lineage envelope. No response or insufficient balance blocks before signing;
expected reimbursement never counts as signer liquidity. This is conservative
point-in-time RPC evidence, not a guarantee against later same-account activity,
provider error, or an observation-to-sign race.

Execution RPC configuration is capped at four unique endpoints. Critical
first-success reads use at most two concurrent endpoints and an eight-second
aggregate deadline, so a slow first endpoint cannot serialize every fallback.
Peer work receives logical cancellation and each HTTP transport has the same
request timeout with internal retries disabled. Broadcast fan-out, startup chain
checks, nonce/balance observations, and receipt reads use the same scheduler.
Finality head and historical-hash corroboration use the bounded all-result path
as well. Health circuits, lineage-level deadlines, and provider
trust groups still require their own bounded policy.

Gas is not hardcoded. Before each initial or replacement reservation, the engine
estimates the exact Station calldata/blob request against an attributed block and
Station runtime-code hash. It takes the largest responding estimate, adds a 25%
round-up margin, applies a 100,000-gas floor, and blocks above a 500,000-gas cap.
Missing estimate evidence, a revert, or code-hash disagreement fails closed.
After durable reservation and again during crash recovery, Station code is
revalidated before signer invocation; drift blocks and requires renewed intent.
Published evidence records the winning limit and actual gas for comparison;
the latest lineage preflight retains its attributed estimates.

Canonical reverted receipts consume execution and blob fees. The engine records
those costs exactly once in actual spend before any later budget decision,
validates receipt blob fields against the intent, and reverses the accounting if
the receipt leaves the canonical chain. A failed lineage remains blocked for
operator reconciliation rather than spending onward from an understated budget.

Operational confirmation depth is not labeled Ethereum finality. Published
records remain `operationally-confirmed` until one or more attributed execution
providers expose a `finalized` head whose canonical block hash matches the
receipt. Conflicting eligible providers block new publication. Segment cleanup
requires `finalized-tag-observed`; unsupported/unavailable tags retain evidence
and media rather than being guessed. This is attributed RPC evidence, not a claim
that configured endpoints are independent or honest.

The version 8 engine prepares the unsigned request, verifies its maximum
exposure against segment and stream limits, then durably stores an immutable
`rfe/publication-intent@1` reservation before invoking the local signer. Signed
output is parsed, its signer is recovered, and every material field is checked
against that reservation before the attempt is durably committed or broadcast.
Earlier state is not treated as version 8 evidence and currently requires
explicit operator migration. Version 8 names its conserved accumulator
`actualSpendWei` because it includes both successful and reverted canonical
receipt costs.

Every transaction-engine state commit carries a monotonically increasing
revision, SHA-256 semantic checksum, and previous-revision checksum. Before a new
current revision is installed, the last validated durable state is flushed to
`publisher-state.json.previous`. Startup requires a valid current checksum and,
for linked revisions, a valid prior link; it never silently resumes from an older
revision after a torn/corrupt current file because that revision might predate
signer authority. The retained prior is operator recovery evidence, not automatic
rollback authorization.

The effective durability mode is recorded in critical state and surfaced in the
operator status. Filesystems that support directory flush use
`file-and-directory-sync`. On this Windows host, directory flush returns `EPERM`,
so the publisher records `file-sync-verified-readback`: file contents are flushed,
then the bounded committed record is reread and its checksum verified before the
transition is acknowledged. The UI labels that capability as degraded rather
than implying a power-loss guarantee the platform cannot establish.

Critical state temporary files left by an interrupted atomic write are never
deleted or interpreted as harmless. Startup discovers at most 16 regular,
non-symlink artifacts under strict per-file and aggregate byte limits, moves them
into a mode-restricted quarantine, hashes each artifact, and writes a bounded
`rfe/publisher-recovery-quarantine@1` marker. That marker permanently forces
`recovery-required`; missing or modified quarantine evidence also fails closed.
Artifact contents and paths are not exposed in public status or logs.

This ordering is proven for the bundled synchronous local-key adapter. External,
interactive, hardware, delegated, and account-abstraction signer outcome
reconciliation is not implemented; do not infer that a signer timeout means no
signature exists.

Before RPC initialization or state recovery, the publisher acquires a
deterministic OS-owned coordinator endpoint scoped by chain ID and publisher
address. Another local process or worktree using that same nonce domain fails
closed, while different chain/account domains can proceed. Process death releases
the endpoint, but a protected durable ownership record remains. Only the same
state file may resume until a clean release with no pending lineage clears that
record. Startup also compares durable and observed pending nonces: external
advancement is adopted only with no local pending lineage, while backward or
out-of-range observations fail closed. A complete operator reconciliation/
takeover workflow for abandoned state remains future work.

The replacement engine has been exercised on Sepolia for a real one-blob
Station publication, but deliberate live fee-bump behavior is covered by
deterministic tests rather than by intentionally stalling a funded transaction.
Treat unattended Mainnet operation as a later operational-hardening milestone,
not as a guarantee from this prototype.

Likewise, `buffer ready` currently means the configured number of segments is
confirmed on chain. It does not know an individual viewer's playhead. A later
viewer feedback channel can turn this into a true end-to-end buffer SLA.

The supervisor resumes durable jobs after it is relaunched. Closing the GUI
does not stop it. Windows startup or service registration is not installed
automatically yet, so a machine shutdown still interrupts a stream.

Persisted job configuration, supervisor state, segment manifests, and publisher
state are read with explicit byte and collection bounds. Unknown job/manifest
fields, unsupported versions, mismatched stream/filesystem identity, duplicate
or reordered segment sequences, and segment paths outside the job directory
stop recovery instead of being treated as empty progress. The supervisor marks
an active job failed when its observed manifest or publisher state cannot be
validated; it does not silently restart children from ambiguous data.
Pending state additionally validates immutable segment fields, nonce uniqueness,
attempt order and hashes, bounded serialized transactions, winner membership,
confirmed record structure, and conservation between confirmed spend and the
sum of recorded transaction costs.

Jobs created before role-isolated `media-job.json` and `publisher-job.json`
files are not auto-upgraded. Restart fails with an explicit migration requirement
instead of recreating broader child capabilities behind the operator's back.

Desktop capture currently captures the whole Windows desktop. Audio is
optional and requires the exact FFmpeg DirectShow capture-device name. The
live URL mode is an ingest mode, not remote execution: this machine still
encodes, signs, and publishes.

Run the local checks with:

```powershell
pnpm test:publisher-console
pnpm test:publisher-safety
```

Looping or rebroadcasting already-published media is not part of this release.
