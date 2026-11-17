# Custom-game upload sessions

The folder upload pipeline keeps game data in the existing `CUSTOM_GAMES` R2
binding. It uses D1 temporarily to detect path conflicts across metadata batches;
apply migration `0101_custom_game_metadata_batches.sql` before publishing the
new Admin. Legacy upload endpoints remain available for older Admin bundles.

## Admin pipeline and recovery

The Admin creates a recoverable unpublished game record before sending a new
folder. It deterministically groups complete files into stored ZIPs up to
200 MiB (3,000 members maximum); larger files stay individual objects. The
Admin uploads metadata in requests capped by both byte and entry counts, with
no more than four metadata requests in flight. Package data still uploads in
binary parts; the metadata change does not alter its 200 MiB bundle plan or
file upload protocol.

New folder uploads use a v4 index object and immutable metadata parts. The index
contains only the logical size, object lookup table, and part keys. Each part
contains one bounded group of file and bundle metadata. The existing Launcher
manifest endpoint streams those parts back using the v3 JSON response shape, so
the Launcher does not need a protocol change. Stored v1-v3 manifests continue
to use their existing read paths.

Two Web Workers prepare packages while two objects upload. A global limiter
allows four binary requests at once, irrespective of which objects own them.
Package reservations include preparing, ready and uploading packages and are
bounded to 400 MiB; direct-file streaming buffers and browser overhead are
additional, bounded allocations. Small-file preparation prefetches at most six
files (12 MiB) per worker. Direct files are read once to calculate SHA-256 and
produce their upload parts, with at most two unacknowledged parts per worker.

IndexedDB stores metadata, hashes and part ETags, never whole game files. Each
unit has its own record so a part confirmation does not rewrite all 20,000 file
descriptors. Reloading requires selecting the same source folder again; its
plan fingerprint must match. A Web Lock prevents another tab starting or
discarding the same game's upload concurrently. If persistent storage is denied,
the Admin explicitly warns that only the current tab can retain progress.

Preparation progress, confirmed objects, current speed, average speed and elapsed
time are separate. ETA uses observed small/large-file preparation samples plus
the recent transfer window and stays in calibration until representative work is
measured. Restored bytes are excluded from measured network speed.

The R2 smoke command `node scripts/smoke-custom-games-r2.mjs merlin-r2` uploads a
temporary 6 MiB multipart through a presigned URL, checks browser CORS and SHA-256
roundtrip, and removes its exact temporary object. It reads the named local AWS
profile in memory and never prints credentials or signed URLs. The production
CORS definition is in `scripts/custom-games-cors.json`.

## Optional direct transport

Server-side variables/secrets:

- `CUSTOM_GAMES_R2_ACCOUNT_ID`: R2 account ID (32 lowercase hexadecimal digits).
- `CUSTOM_GAMES_R2_ACCESS_KEY_ID`: bucket-scoped S3 access key ID (secret).
- `CUSTOM_GAMES_R2_SECRET_ACCESS_KEY`: corresponding S3 secret key (secret).
- `CUSTOM_GAMES_R2_BUCKET`: optional bucket name; defaults to `custom-games` and
  must point at the same bucket as the `CUSTOM_GAMES` Workers binding.

All credentials stay in the Worker. The Admin receives 15-minute signed PUT
URLs for specific multipart parts of objects reserved by its own upload session.
If credentials are absent, sessions use the authenticated proxy transport.

The bucket must allow PUT from the exact Admin origin and expose `ETag` through
CORS. The Admin Content Security Policy must include only the configured R2
origin in `connect-src`; use `customGamesR2Origin(env)` to obtain it. No wildcard
origin or publicly writable bucket is needed. Before switching production Admin
to `https://admin.api-merlin.com`, add it to the production bucket policy while
retaining the old origin during the transition. Staging has a separate policy in
`scripts/custom-games-cors.stage.json` for its own bucket and Admin host.

## Contract

All routes below are under `/panel-api/custom-games/upload`; mutations require
the existing Admin cookie, CSRF and origin checks. Sessions belong to an Admin
user and game ID, and expire seven days after creation.

- `POST /sessions`: `{ gameId, fingerprint, planVersion: 2, sessionId? }`.
  Fingerprint is a SHA-256 hexadecimal string identifying the selected file plan.
  Supplying an existing session ID verifies both the fingerprint and owner.
  Returns `sessionId`, `status`, `transport`, `partSize`, `expiresAt`, `objects` and,
  once finalization starts, `manifestId`/`manifestKey`.
- `GET /sessions/:id`: restores that same state. Each object includes `clientId`,
  `key`, `filename`, `sizeBytes`, `uploadId`, `completed`, `state`, and SHA/ETag
  when known. Bundle member metadata and individual uploaded part ETags remain
  in Admin IndexedDB.
- `POST /sessions/:id/objects/initiate`: `{ clientId, filename, sizeBytes,
  sha256? }`. Replays return the original reservation, not another multipart.
  Empty objects require the empty-file SHA-256 and complete immediately.
- `POST /sessions/:id/objects/sign`: `{ clientId, partNumbers: number[] }`.
  Returns `{ parts: [{ partNumber, url }], expiresIn: 900 }`. At most 16 parts
  are signed per request. URLs authorize PUT only and must not be logged.
- `POST /sessions/:id/objects/part?clientId=...&partNumber=...`: proxy upload of
  one binary part. Its size must match the reserved object and 64 MiB part plan.
- `POST /sessions/:id/objects/complete`: `{ clientId, sizeBytes, sha256,
  parts: [{ partNumber, etag }] }`. SHA-256 is required. Completion checks R2
  size and persists the object checkpoint. A lost completion response is safe
  to retry: an existing object or completed checkpoint is recognized.
- `POST /sessions/:id/metadata/batches/:index`: `{ manifestId, entries }`.
  Each request is limited to 256 KiB and 500 file entries; the Admin targets
  240 KiB and 400 entries to leave framing room. Replaying an identical batch
  is safe and repairs a missing R2 metadata object. A different payload at an
  existing index is rejected. D1 tracks normalized paths and rejects duplicates
  and file-versus-directory conflicts across requests. The API streams the
  request body through the byte limit before parsing it, including when the
  caller omits `Content-Length`.
- `POST /sessions/:id/metadata/complete`: `{ manifestId, batchCount }`.
  The API requires every sequential batch, then processes up to 32 batches in a
  request while checking no more than 400 distinct uploaded objects in that
  invocation. It returns `status: "processing"` with progress until all
  immutable parts are present, then writes the v4 index and returns the manifest
  key. Retries resume at the last committed batch. The index is published only
  after validation and all parts are complete.
- `POST /folder/complete`: existing manifest payload, plus optional `sessionId`.
  For session uploads, all reserved objects must be completed and correspond
  exactly to the submitted keys, sizes, and hashes. The finalizing session locks
  the manifest ID; retries with that same ID can finish after response loss.
- `POST /sessions/:id/cancel`: marks an open session cancelled, aborts its
  incomplete multiparts, and deletes only objects owned by that session. A
  finalizing session can be discarded after ten minutes only when its manifest
  has not been written or linked to a game/version. Finalized sessions cannot
  be cancelled.

## Expiration and observations

Call `cleanupExpiredGameUploads(CUSTOM_GAMES, Date.now(), 10, merlin_db)` from
the existing scheduled handler. It processes at most ten expired sessions by default, using a compact
expiry index rather than scanning game files. Only cancelled or expired open
sessions lose their own upload objects and temporary metadata/path-index rows.
Finalizing and finalized game packages are never removed by this cleanup. Expired finalizing sessions emit a recovery
warning and leave the expiry queue, allowing later sessions to be cleaned. Small session/checkpoint records remain for
recovery and diagnosis after the expiry marker is removed.

A Worker termination between R2 multipart creation and persistence of its
upload ID cannot be made transactional. A reservation older than two minutes
can be prepared again; R2's incomplete-multipart lifecycle handles the abandoned
upload if that narrow interruption occurs. Keep the bucket's incomplete multipart
expiration enabled.

Logs include session/game/client IDs, byte counts, and elapsed times for proxied
parts, completed objects, finalization, cancellation, and expiration cleanup.
They never include S3 credentials, signed URLs, or file contents.

## Synthetic large-folder validation

Run `npx vitest run src/lib/custom-game-metadata-finalization.test.ts` to exercise
the real Hono upload/finalization handlers with SQLite as a D1-compatible local
database and an in-memory R2 fake. On Node 22, 277,000 paths completed in 5.4 s
with 739 metadata batches, 24 finalization requests and 39.6 MB total request
JSON; 500,000 paths completed in 10.5 s with 1,333 batches, 42 finalization
requests and 71.4 MB of request JSON. The harness also streams both Launcher
manifest contracts and verifies cleanup, replay recovery and path collisions.
Boundary-sampled Node RSS reached about 580 MB and 1.01 GB, respectively; the
local harness retains fake R2 objects and SQLite state in process memory. These
timings and memory samples do not measure Cloudflare Worker CPU/memory or real
R2/D1 latency and must not be used as production throughput estimates.
