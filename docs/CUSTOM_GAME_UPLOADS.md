# Custom-game upload sessions

The folder upload pipeline uses the existing `CUSTOM_GAMES` R2 binding. No D1
migration is required. Legacy upload endpoints remain available for requests
started by an older Admin bundle.

## Admin pipeline and recovery

The Admin creates a recoverable unpublished game record before sending a new
folder. It deterministically groups complete files into stored ZIPs up to
200 MiB (3,000 members maximum); larger files stay individual objects. Manifest
v3 and the Launcher package format are unchanged.

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
origin or publicly writable bucket is needed.

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
- `POST /folder/complete`: existing manifest payload, plus optional `sessionId`.
  For session uploads, all reserved objects must be completed and correspond
  exactly to the submitted keys, sizes, and hashes. The finalizing session locks
  the manifest ID; retries with that same ID can finish after response loss.
- `POST /sessions/:id/cancel`: marks an open session cancelled, aborts its
  incomplete multiparts, and deletes only the objects reserved by that session.
  A finalizing or finalized session cannot be cancelled.

## Expiration and observations

Call `cleanupExpiredGameUploads(CUSTOM_GAMES)` from the existing scheduled
handler. It processes at most ten expired sessions by default, using a compact
expiry index rather than scanning game files. Only cancelled or expired open
sessions lose their own upload objects. Finalizing and finalized game packages
are never removed by this cleanup. Expired finalizing sessions emit a recovery
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
