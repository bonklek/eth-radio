# Repository Modes

Radio Free Ethereum has three operational surfaces. They should stay distinct in
what they are allowed to do, but the two watcher surfaces should stay feature
identical.

## Publisher Tools

Publisher scripts run locally for an operator. They take an already-formed MP4 or
derived WebM segments, publish payload bytes into Ethereum blobs, and emit
Station events. This side is allowed to use wallets, private keys, local files,
and operator RPC credentials.

Publisher-only code belongs in scripts and should not be bundled into the static
watcher.

## Hosted Watcher

The hosted watcher is the static client in `public/decentralized/`, built to
`dist/decentralized/` and published to IPFS/IPNS or another static host. It has
no app server and no private credentials. It watches by using browser-accessible
execution RPCs and beacon REST APIs, then verifies reconstructed payloads before
playback.

This is the canonical user-facing watch surface.

## Self-Hosted Watcher

The self-hosted watcher should use the same static client as the hosted watcher.
The local server is only a file server for development and local testing. Users
can point the UI at their own execution RPC and beacon API from the settings
panel instead of relying on public defaults.

Run:

```powershell
pnpm web:serve
```

This builds `dist/decentralized/` and serves it locally without adding any API
routes. The result should match the hosted IPFS watcher except for the URL and
the endpoint configuration chosen by the viewer.

## Compatibility Rule

Watcher features must land in the static client first or in browser-safe shared
modules consumed by the static client. The local watcher may improve iteration
speed, logging, or test ergonomics, but it should not grow private playback,
blob reconstruction, metadata cache, or blobspace behavior that the hosted
watcher cannot also use.

The older Node live demo can remain useful as an operator/debugging tool while
the project migrates, but it is not the canonical watcher surface.
