# Release notes

`0067_release_notes.sql` creates releases and their five localized records. The seed publishes `2.0.0` as a Major release.

- Launcher: `GET /api/release-notes?locale=` requires a launcher license and returns published releases.
- Admin: `/panel-api/release-notes` requires an admin session; create, edit and delete mutations keep CSRF protection.
- Hero uploads accept validated images up to 12 MB and are stored in `MERLIN_FILES`; their IDs are generated server-side.
- The launcher opens automatically only when its own version has an unseen published release. It must hide the manual entry point when the live request fails; a stale cache is not UI availability.

Do not put release content, image paths, secrets, or real user data in source fixtures unless it is intentionally public.
