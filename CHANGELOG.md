# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] - 2026-10-17

### Security

- Admin panel now requires login. `ADMIN_PASSWORD` is checked with a timing-safe compare. Session is an HMAC-SHA256 signed `admin_session` cookie (HttpOnly, SameSite=Strict, Secure in production, 12h TTL).
- Admin role is no longer taken from client events. Every admin socket event checks the session and replies `UNAUTHORIZED` (also emits `unauthorized`). Admin privileges end when the session expires.
- Login rate limited to 5 attempts per minute per IP.
- Fail closed: admin is disabled when `ADMIN_PASSWORD` is unset.
- `/admin.html` and `/admin` are guarded on decoded and normalized paths.
- Guest handlers use only the server-side room and name set by `guestConnected`. Guests can no longer read or post to other rooms, post into the internal `admins` room, or use the name "Admin" (reserved, case-insensitive).
- Upload validation: extension derived from a MIME allow-list; magic-byte checks (PNG, JPEG, GIF, WebP, PDF, ZIP/DOCX/XLSX, DOC/XLS); size checked before decoding; base64 charset validated.
- Attachments served with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, and `Content-Disposition: attachment` for non-images.
- Security headers on all responses: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, Content-Security-Policy. `X-Powered-By` disabled.
- Dependencies updated with `npm audit fix` (non-breaking). Production dependencies: 0 known vulnerabilities.
- MySQL (3306) and phpMyAdmin (8086) bound to `127.0.0.1`.

### Fixed

- Sender names no longer double-escaped.
- Duplicate submits prevented while a file is being read or sent.
- Failed sends keep the draft until the server acknowledges.
- Client-side file size and type validation (oversize payloads were silently dropped).
- "Loading..." no longer stuck after a server error.
- Older history loads automatically when the first page does not fill the screen.
- Scroll-to-bottom no longer races with image loading.
- Admin draft and attachment no longer leak across rooms.
- Events for other rooms are filtered.
- Guest "say hello" hint no longer flashes before history loads.
- No duplicate `guestConnected` on first connect.
- Guest composer enabled only after join is acknowledged.
- localStorage access guarded.
- Long names and URLs wrap instead of overflowing.
- Inputs use 16 px text on mobile to avoid iOS zoom.
- Process reliability: server waits for the DB before listening; `unhandledRejection` logged; `uncaughtException` logs and exits; graceful shutdown on SIGTERM/SIGINT (10 s hard timeout).
- Dev server receives SIGTERM (tini via `init: true`, nodemon run directly).
- Socket.IO emits use acks with timeouts.
- Validation errors returned to the client; internal errors logged and replaced with "Something went wrong".
- Startup `sleep 15` replaced with a DB healthcheck and `depends_on: service_healthy`.

### Added

- Admin login page (`/login.html`) with errors for invalid, rate-limited and expired sessions.
- Admin logout button and `POST /admin/logout`.
- `GET /healthz` endpoint (503 when the DB is unreachable).
- App Docker `HEALTHCHECK` on `/healthz`.
- Per-socket rate limits: message events 10 per 10 s; other events 30 per 10 s.
- Input limits: messages up to 5000 characters; names up to 80; `beforeId` must be a positive integer; admin messages require an existing room.
- Reconnecting banner; composer disabled while offline.
- "End chat" confirmation.
- Character counter near the 5000-character limit.
- Accessibility: keyboard-reachable file input, labelled inputs, live message log, accessible toasts, focus-visible outlines, reduced-motion support, mobile drawer with `aria-expanded`, `aria-controls`, `inert` and Escape to close, labelled icon buttons, touch targets 40 px or larger.
- Automated test suite (`npm test`, `node:test` with `socket.io-client`): 70 top-level tests (82 with subtests) across unit and integration suites.
- `.dockerignore` and `.gitignore`; `.env.example`.
- `src/` modules and `createApp` factory; `public/js/common.js` for shared client code.

### Changed

- Node image `node:18` (EOL) replaced with `node:22-slim`.
- `server.js` split from 390 lines into `src/config.js`, `db.js`, `auth.js`, `attachments.js`, `validate.js`, `rateLimit.js`, `sockets.js`, `app.js`. `server.js` is bootstrap only.
- Inline JavaScript moved from HTML into `public/js/*.js`.
- Room list uses a single query builder with one LEFT JOIN on `MAX(id)` per room.
- Admin viewer check uses an O(1) counter map instead of an O(n) scan.
- `package.json`: `main` set to `server.js`; scripts `start`, `dev`, `test`; `engines` node >= 20; nodemon watches only `server.js` and `src`.
- Express 4.22.3, Socket.IO 4.8.1 (engine.io 6.6.11).
- Line endings normalized from CRLF to LF in `Dockerfile` and `docker-compose.yml`.
- Secrets are read from `.env` (gitignored); compose passes `ADMIN_PASSWORD` and `SESSION_SECRET`.

### Removed

- `multer` dependency (unused).
- Published MySQL and phpMyAdmin ports on all interfaces.

### Performance

- Room list: 4 correlated subqueries per room replaced with one LEFT JOIN on `MAX(id)`.
- Admin "is anyone viewing this room" check: O(n) array scan replaced with O(1) counter map.

### Infrastructure

- `db` service: healthcheck with `mysqladmin ping`; `app` waits with `depends_on: service_healthy`.
- `app` service: `init: true` (tini); `restart: unless-stopped`; `HEALTHCHECK` on `/healthz`.
- Dockerfile: `CMD ["node", "server.js"]`; `npm ci` in build.
- Database volume `db_data` unchanged.

### Upgrade notes

- Rebuild with `docker compose up -d --build`; the `db-setup` service applies migrations automatically.

## [Unreleased] - 2026-10-17 (follow-up)

### Security / Infrastructure

- MySQL root password is now a secret in `.env` (`MYSQL_ROOT_PASSWORD`, required by compose) and was rotated on the existing `chat_db_data` volume. The app no longer receives it (`env_file` removed).
- App connects as the least-privilege `chat_app` user (`SELECT, INSERT, UPDATE, DELETE` on `chat`; all privileges on `chat_test` only). Password is `DB_APP_PASSWORD` in `.env`.
- New one-shot `db-setup` service (`db/setup.sh`): idempotent user/grants setup and migration runner (`db/migrations/`, tracked in `schema_migrations`). `app` waits for it to complete successfully.
- Migration `001_room_fk_and_guest_token`: `chat_room.room` widened to 255, `chat_room.guest_token_hash`, foreign key `messages.room -> chat_room.room` (cascade), index `idx_room_unread`. Orphan messages are adopted as rooms, not deleted. `chat.sql` updated to the final schema and pre-registers the migration.
- phpMyAdmin moved to the `tools` profile, no stored root password.
- App container runs as non-root `node`. Uploads moved to the `uploads` named volume (`UPLOAD_DIR=/usr/src/app/uploads`); existing files were copied into it.
- nodemon replaced by Node's built-in `--watch-path` in the dev compose command.
- Added `docker-compose.prod.yml` and `deploy/Caddyfile`: Caddy TLS reverse proxy with HSTS, `NODE_ENV=production`, `TRUST_PROXY=1`, no source bind mount, no published app/db ports.
- `test/helpers.js` `setupDb` now drops and recreates tables from `chat.sql` (needed for the FK).
- `backups/` and `uploads/` added to `.gitignore`.

### App-side follow-up

- Uploads are written to `UPLOAD_DIR` (default `<app>/uploads`; `/usr/src/app/uploads` volume in compose) and served from there under the unchanged `/attachement/<file>` URL with the same protective headers (`nosniff`, CSP `sandbox`, `Content-Disposition: attachment` for non-images). `public/attachement` is legacy leftovers and is no longer served (also not via encoded paths).
- `TRUST_PROXY` (`1`/`true` = one hop, default off) sets Express `trust proxy` and decides where the socket client IP comes from (first `X-Forwarded-For` entry vs. the TCP address).
- Per-IP abuse limits (in memory, single instance only): `MAX_SOCKETS_PER_IP` (20 concurrent sockets, excess rejected with "Too many connections"), `ROOMS_PER_IP` (10 new chats per 10 min, "Too many new chats, try again later"), `MESSAGES_PER_IP` (30 guest message events per 10 s across all sockets of an IP), in addition to the per-socket limits. Counters are cleaned up on disconnect; windows are pruned.
- Upload quota `MAX_UPLOAD_DIR_BYTES` (default 1 GiB): the size of `UPLOAD_DIR` (non-recursive) is computed at startup and tracked; saves that would exceed it fail with "Upload storage is full".
- `npm run uploads:prune` (`scripts/prune-uploads.js`): removes files in `UPLOAD_DIR` that no `messages.attachment_path` references and that are older than `--min-age-hours` (default 24). Dry run unless `--apply`.
- Guest token: `guestConnected` now requires the per-room secret token to resume an existing room. The client generates a random 32-byte token before its first join (see the follow-up section for why); only its SHA-256 is stored in `chat_room.guest_token_hash`, compared in constant time. Legacy rooms without a token are claimed atomically by the first guest to connect. A wrong or missing token gets the same "Invalid room" error as a malformed id. The browser keeps the token in `localStorage` (`guestToken`).
- A message for a nonexistent room (foreign key violation) is reported as "Room not found".
- nodemon removed; `dev` uses `node --watch-path`. ESLint (flat config, `npm run lint`) added; existing lint findings fixed.
- Tests: 104 (22 added) covering the items above; uploads tests use a throwaway directory instead of `public/attachement`.

## Follow-up: automated E2E suite

- Added a Playwright end-to-end suite in `e2e/` (`@playwright/test` 1.56.1, Chromium only) covering console/CSP cleanliness, the admin guard and login, the guest flow (reserved name, text, PNG, oversized file), realtime guest/admin exchange, resume and token tampering, End chat, logout, responsive layout (375x812, 390x844, 768x1024, 1366x768, 1920x1080), keyboard focus and ARIA roles.
- New compose services under the `e2e` profile (not started by default): `app-e2e` (same image as `app`, database `chat_test`, own `uploads_e2e` volume, high per-IP limits) and `e2e` (the `mcr.microsoft.com/playwright:v1.56.1-noble` runner). Existing services are unchanged.
- `e2e/reset-db.js` drops and recreates the `chat_test` tables from `chat.sql` before each run and refuses unless `DB_NAME` ends with `_test`. The admin logs in once in a Playwright `globalSetup` (login is limited to 5/min/IP) and the session is reused through `storageState`.
- `e2e/playwright-report`, `e2e/test-results`, `e2e/node_modules` and `e2e/.auth` added to `.gitignore` and `.dockerignore`.

## Follow-up: remaining risks resolved - 2026-10-17

### Security

- Admin sessions are server-side. The cookie is now `exp.sid.hmac`. Only the SHA-256 of `sid` is stored, in the new table `admin_sessions` (migration `002_admin_sessions`, `expires_at` in epoch ms). Expired rows are pruned on login. Every admin page and socket check requires the session row to exist. Old-format cookies are rejected.
- Logout deletes the session and immediately removes admin rights from that session's live sockets. Before, a copied token stayed valid until it expired.
- Guest tokens are generated by the client, not issued by the server. The server verifies with `timingSafeEqual`. Wrong or missing tokens get "Invalid room".

### Fixed

- Clicking Log out showed "Your session expired". The revocation notice sent to the admin's own socket raced the logout redirect. `admin.js` now ignores the revocation notice of its own logout.

### Added

- Playwright end-to-end suite now also has ESLint coverage: the flat config (`eslint.config.js`) covers `e2e/` together with server, src, scripts, test and public/js.
- `LOGIN_MAX_ATTEMPTS` environment variable (default 5 per minute per IP).
- Migration `002_admin_sessions` (table `admin_sessions`).

### Changed

- The guest token is generated in the browser before the first join, so a retried join after a lost acknowledgement still matches. Older clients without a token still get a server-issued one. Corrects the earlier note that the server issues every token.
- `LOGIN_MAX_ATTEMPTS` is configurable. Before, the limit was fixed at 5.
- Playwright repinned from 1.49.1 to 1.56.1 (`@playwright/test` and image `mcr.microsoft.com/playwright:v1.56.1-noble`) because the 1.49.1 image pull stalled.
- Config defaults: `DB_USER` defaults to `chat_app` and `DB_PASSWORD` to empty.
- Tests: 108 (was 82 at the first round, 104 at the earlier follow-up).

### Removed

- The `root`/`root` fallback in `src/config.js`. The app never connects as root.
