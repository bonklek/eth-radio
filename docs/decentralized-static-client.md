# Decentralized Static Client

The static Radio Free Ethereum client in `public/decentralized/` is designed for
IPFS, Arweave, Filecoin gateways, or any plain static file host. It does not call
the local Node demo API.

Runtime data flow:

1. The browser reads `SegmentPublished` logs from the configured execution RPC.
2. The browser fetches beacon blob sidecars from the configured beacon REST API.
3. The browser derives blob versioned hashes from KZG commitments and matches
   them against the Station event.
4. The browser reconstructs the payload by dropping the leading zero byte from
   each 32-byte blob field element.
5. The browser verifies the reconstructed payload SHA-256 against the Station
   event before playback.
6. Verified WebM payloads are cached in IndexedDB on the user's machine.

The browser never trusts a transport source. Payloads fetched from beacon APIs or
from archival mirrors must hash to the `payloadSha256` emitted by the Station
contract before playback or cache insertion.

## Endpoint Fallbacks

The client accepts newline-separated execution RPCs and beacon REST APIs. It
tries each endpoint in order for every request, records the active working
endpoint in the UI, and keeps going when a provider rejects a browser request or
temporarily fails. These endpoints must be CORS-friendly because the requests are
made directly by the browser.

Execution endpoints must support:

- `eth_blockNumber`
- `eth_getLogs`
- `eth_getTransactionByHash`
- `eth_getBlockByHash`

Beacon endpoints must support:

- `/eth/v1/beacon/genesis`
- `/eth/v1/beacon/blob_sidecars/{slot}`

## Archival Fallbacks

Beacon nodes are not required to serve old blob sidecars forever. For old
segments, configure archival payload URL templates. The client replaces these
tokens:

- `{streamId}`
- `{sequence}`
- `{txHash}`
- `{payloadSha256}`

Example:

```text
https://gateway.example/ipfs/bafy.../{streamId}/{sequence}.webm
https://arweave.net/{payloadSha256}.webm
```

Archive payloads are still verified against Station metadata before playback.
This lets IPFS, Arweave, Filecoin, torrents, or community mirrors participate
without becoming trusted servers.

## Progressive Playback And Cache

The static tuner prefetches recent segments, verifies payloads, and stores them
in IndexedDB. `Start stream` refreshes Station logs on an interval and keeps the
recent verification queue warm. The cache limit setting evicts the oldest
verified payloads when local storage grows past the configured size. `Export
index` downloads cache metadata without embedding the media bytes, and `Clear
cache` removes verified local payloads.

## Static Build

Create a deterministic directory for pinning:

```powershell
pnpm web:build
pnpm web:static
```

The build output is `dist/decentralized/`. Pin or upload that directory to IPFS,
Arweave, Filecoin, or another static host.

Operational notes:

- Execution RPC and beacon endpoints must allow browser CORS requests.
- Public RPC URLs in the app are not secrets. Users can replace them in the UI.
- Old Ethereum blob sidecars are not guaranteed to remain available forever.
  Durable playback still needs public archival mirrors such as IPFS, Arweave, or
  Filecoin for old reconstructed segments or old sidecars.
- Private keys, unpublished assets, and operational credentials stay outside the
  static app. Station contracts, source, public protocol docs, and published
  media metadata are intended to be public.

To preview locally, open `public/decentralized/index.html` from a static server:

```powershell
python -m http.server 8080 -d public/decentralized
```

Then visit `http://127.0.0.1:8080/`.
