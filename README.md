# chat

A real-time guest-to-admin support chat. Node.js 22, Express 4, Socket.IO 4 and MySQL 8, running fully in Docker.

Guests chat with an admin, can attach files (5 MB max), and resume their conversation after a reload. Admins sign in, see an inbox of rooms with unread markers, and reply with text or attachments.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/) v2 (`docker compose`)
- Host ports `3002` and `3306` free (`8086` too if you use phpMyAdmin)

Node.js is not needed on the host. All commands run in containers.

## Setup

1. Create your environment file:

   ```bash
   cp .env.example .env
   ```

2. Set these in `.env` (placeholders and comments are in `.env.example`):

   | Variable | Purpose | Generate with |
   |----------|---------|---------------|
   | `ADMIN_PASSWORD` | Admin login | choose one |
   | `SESSION_SECRET` | Cookie signing | `openssl rand -hex 32` |
   | `MYSQL_ROOT_PASSWORD` | MySQL root (db and db-setup only) | `openssl rand -hex 24` |
   | `DB_APP_PASSWORD` | Password of the least-privilege `chat_app` user the app connects as | `openssl rand -hex 24` |

   `docker compose` refuses to start if `MYSQL_ROOT_PASSWORD` or `DB_APP_PASSWORD` is missing.

   **Existing database volume:** MySQL only applies `MYSQL_ROOT_PASSWORD` when it creates the volume. To rotate the root password on an existing `db_data` volume, change it with SQL first (using the old password), then update `.env`:

   ```bash
   docker exec -e MYSQL_PWD=<old> chat-db mysql -uroot -e "ALTER USER 'root'@'localhost' IDENTIFIED BY '<new>'; ALTER USER 'root'@'%' IDENTIFIED BY '<new>'; FLUSH PRIVILEGES;"
   ```

   `.env` is gitignored. Do not commit it.

   If `ADMIN_PASSWORD` is empty, admin login is disabled (fail closed).

## Run

```bash
docker compose up -d --build
```

Start order: `db` (healthy) -> `db-setup` (one-shot, must exit 0) -> `app`. On the first boot, MySQL imports `chat.sql`.

Code is bind-mounted and reloaded by Node's built-in watcher (`node --watch-path=server.js --watch-path=src server.js`). Changes to other paths (for example `package.json`) need a rebuild.

After pulling changes, run `docker compose up -d --build` again.

## Services

| Service | Image / build | Purpose | Host binding | URL |
|---------|---------------|---------|--------------|-----|
| `app` (`chat-app`) | Build `.` (`node:22-slim`) | Express and Socket.IO chat server | `3002:3000` (all interfaces) | http://localhost:3002 |
| `db` (`chat-db`) | `mysql:8.0` | MySQL database, schema from `chat.sql` on first boot | `127.0.0.1:3306` | `127.0.0.1:3306` |
| `db-setup` | `mysql:8.0` | One-shot: creates the `chat_app` user and grants, applies `db/migrations/` (see below). Safe to run on every `up` | none | none |
| `phpmyadmin` (`chat-phpmyadmin`) | `phpmyadmin/phpmyadmin` | Web UI for the database. Profile `tools`, not started by default | `127.0.0.1:8086` | http://127.0.0.1:8086 |

phpMyAdmin has no stored credentials. Start it when needed and log in with the MySQL root user:

```bash
docker compose --profile tools up -d phpmyadmin
docker compose --profile tools rm -sf phpmyadmin   # stop and remove it again
```

## Database setup and migrations

- `db-setup` runs `db/setup.sh` on every `docker compose up`. It is idempotent: it creates `chat_app` (and re-applies its password, so rotating `DB_APP_PASSWORD` just works), grants `SELECT, INSERT, UPDATE, DELETE` on `chat.*` and `ALL` on `chat_test.*` (tests drop and create tables there), and creates `chat_test`.
- Migrations live in `db/migrations/NNN_name.sql`. They are applied to `chat` in order, once each, and recorded in `schema_migrations`. A failing migration stops the run, so `app` does not start.
- `chat.sql` is the final schema for fresh volumes and pre-registers the migrations it already contains, so they are not re-applied.
- To add a migration: create the next `NNN_name.sql`, update `chat.sql` to the same end state and add the version to its `schema_migrations` insert.
- Run it manually: `docker compose run --rm db-setup`.
- The app user cannot change the schema. Migrations run as root through `db-setup`.

Health:
- `db` has a healthcheck (`mysqladmin ping`). `app` starts after it is healthy.
- `app` has a Docker healthcheck on `GET /healthz`.

## Admin login

- Log in at http://localhost:3002/login.html using the `ADMIN_PASSWORD` value from `.env`.
- Login creates a server-side session. The browser gets an HMAC-signed `admin_session` cookie (`exp.sid.hmac`, HttpOnly, SameSite=Strict, 12 hours). Only the SHA-256 of the session id is stored, in the `admin_sessions` table. Sessions survive app restarts.
- Every admin page and socket event checks that the session row exists. A copied cookie stops working as soon as its session is deleted or expires.
- Login is limited to `LOGIN_MAX_ATTEMPTS` attempts per minute per IP (default 5).
- Unauthenticated requests to `/admin.html` or `/admin` redirect to the login page.
- Use the Log out button in the admin panel to end the session. Logout deletes the session on the server and removes admin rights from open admin sockets.
- Upgrade note: cookies issued before migration 002 are rejected, so admins log in again once.

## Environment

Variables are set in `docker-compose.yml`, with secrets read from `.env`.

| Service | Variable | Value / default | Purpose |
|---------|----------|-----------------|---------|
| `app` | `DB_HOST` | `db` | MySQL host |
| `app` | `DB_USER` | `chat_app` (code default) | Least-privilege MySQL user. The app never connects as root; there is no root fallback in code |
| `app` | `DB_PASSWORD` | `DB_APP_PASSWORD` from `.env` (code default: empty) | MySQL password |
| `app` | `UPLOAD_DIR` | `/usr/src/app/uploads` (code default: `<app>/uploads`) | Where uploads are stored (the `uploads` volume), served at `/attachement/` |
| `app` | `DB_NAME` | `chat` | Database name (tests use `chat_test`) |
| `app` | `TRUST_PROXY` | unset (off) | `1`/`true`: trust one reverse-proxy hop (`X-Forwarded-For`) for client IPs. Enable only behind a proxy that sets it (the prod override does) |
| `app` | `MAX_SOCKETS_PER_IP` | `20` | Max concurrent Socket.IO connections per IP ("Too many connections") |
| `app` | `ROOMS_PER_IP` | `10` | New chats an IP may create per 10 minutes |
| `app` | `MESSAGES_PER_IP` | `30` | Guest message events per IP per 10 seconds, across all its sockets (per-socket limits still apply). Admins are exempt |
| `app` | `MAX_UPLOAD_DIR_BYTES` | `1073741824` (1 GiB) | Upload storage quota; saves beyond it fail with "Upload storage is full" |
| `app` | `ADMIN_PASSWORD` | from `.env` | Admin login password. Empty disables admin |
| `app` | `SESSION_SECRET` | from `.env` | Secret for signing the admin cookie |
| `app` | `LOGIN_MAX_ATTEMPTS` | `5` | Admin login attempts per IP per minute |
| `db`, `db-setup` | `MYSQL_ROOT_PASSWORD` | from `.env` | MySQL root password |
| `db-setup` | `DB_APP_PASSWORD` | from `.env` | Password set for `chat_app` |
| `db` | `MYSQL_DATABASE` | `chat` | Database created on first boot |
| `phpmyadmin` | `PMA_HOST` | `db` | MySQL host phpMyAdmin connects to |

Do not put real secrets in `docker-compose.yml`. Put them in `.env`.

The per-IP limits (`MAX_SOCKETS_PER_IP`, `ROOMS_PER_IP`, `MESSAGES_PER_IP`) and the upload quota counter are kept in memory, so they are per process and only valid for a single app instance. Without `TRUST_PROXY` the TCP peer address is used; with it, the first `X-Forwarded-For` entry. Never enable it when clients can reach the app directly, because they could spoof the header.

## Guest chat tokens

A guest chat is identified by its room id plus a secret token. Before the first join, the browser generates a random 32-byte token and keeps it in `localStorage` (`guestToken`) next to the room id. The server stores only its SHA-256 (`chat_room.guest_token_hash`) and compares it in constant time. Generating the token in the browser means a retried join after a lost acknowledgement still matches. A wrong or missing token gets "Invalid room", the same as an unknown id. Rooms that predate tokens are claimed by the first guest who reconnects, and clients without a token get a server-issued one. Ending a chat or losing browser storage means the chat cannot be resumed from that browser (admins still see it).

## Volumes and persistence

| Mount | Target | Purpose |
|-------|--------|---------|
| `db_data` (named volume) | `/var/lib/mysql` | Database files. Survives restarts |
| `./chat.sql` (bind) | `/docker-entrypoint-initdb.d/chat.sql` | Schema, imported only when `db_data` is first created |
| `./db` (bind, read-only) | `/db` (db-setup) | `setup.sh` and migrations |
| `.` (bind) | `/usr/src/app` | Source for live reload |
| `uploads` (named volume) | `/usr/src/app/uploads` | Uploaded files, owned by `node` (uid 1000) |
| `/usr/src/app/node_modules` (anonymous volume) | | Keeps the image's `node_modules` |

Uploaded files are stored in the `uploads` volume (`UPLOAD_DIR`). The URL path stays `/attachement/`. The app container runs as the unprivileged `node` user. The old `public/attachement/` directory is no longer the storage location; its files were copied into the volume and can be deleted once you have confirmed them.

The host-side `uploads/` directory that appears in the project is only the bind-mount mount point (gitignored).

### Cleaning up orphaned uploads

`npm run uploads:prune` lists files in `UPLOAD_DIR` that no message references (matched by file name) and that are older than `--min-age-hours` (default 24). It is a dry run unless `--apply` is given:

```bash
docker compose exec -T app npm run uploads:prune                                  # dry run
docker compose exec -T app npm run uploads:prune -- --apply --min-age-hours 72    # delete
```

The running server counts upload size from startup, so restart `app` afterwards to reclaim quota.

## Project layout

```
server.js            Bootstrap: wait for DB, listen, graceful shutdown
src/
  app.js             Express app factory (createApp)
  config.js          Configuration from environment
  db.js              MySQL pool and room query builder
  auth.js            Admin password check, signed cookie, server-side sessions
  attachments.js     Upload validation (MIME allow-list, magic bytes), saving, size quota
  clientIp.js        Client IP of a socket (TRUST_PROXY aware)
  validate.js        Input validation rules
  rateLimit.js       Per-socket and login rate limiting
  sockets.js         Socket.IO event handlers
scripts/
  prune-uploads.js   Orphaned upload cleanup (npm run uploads:prune)
eslint.config.js     ESLint flat config (npm run lint)
e2e/                 Playwright suite (reset-db.js, global setup, specs)
public/
  guest.html  admin.html  login.html  index.html
  js/                common.js, guest.js, admin.js, login.js, tw-config.js
  attachement/       Legacy upload location (gitignored)
test/
  unit/              Validation, auth, attachments, rate limiter
  integration/       HTTP, Socket.IO, uploads
  helpers.js
chat.sql             Database schema (fresh installs)
db/setup.sh          db-setup: app user, grants, migration runner
db/migrations/       NNN_name.sql migrations
deploy/Caddyfile     Caddy reverse proxy config (production)
docker-compose.yml   Services
docker-compose.prod.yml  Production override (Caddy, no bind mounts)
Dockerfile
```

## Production

`docker-compose.prod.yml` is an override (needs Docker Compose 2.24 or newer):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

- `app`: `NODE_ENV=production`, `TRUST_PROXY=1`, runs `node server.js` from the image built with `npm ci --omit=dev` (no source bind mount, no published port), only the `uploads` volume is mounted.
- `db`: no published port.
- `caddy` (`caddy:2.8.4-alpine`) publishes 80 and 443 and proxies to `app:3000` (including WebSockets), with `Strict-Transport-Security`. Config: `deploy/Caddyfile`. Certificates persist in the `caddy_data` volume.
- Set `SITE_ADDRESS=chat.example.com` in `.env` for automatic Let's Encrypt. The default `localhost` uses Caddy's internal CA (browsers warn).
- Check: `curl -sk https://localhost/healthz`. The admin session cookie is `Secure`.

## Backups

Dump the database and copy the uploads (`backups/` is gitignored):

```bash
mkdir -p backups
docker compose exec -T -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" db mysqldump -uroot --single-transaction --routines chat > backups/chat-$(date +%Y%m%d-%H%M%S).sql
docker run --rm -v chat_uploads:/u:ro -v "$PWD/backups":/b node:22-slim cp -a /u /b/uploads-$(date +%Y%m%d-%H%M%S)
```

Restore the database (overwrites the tables in the dump):

```bash
docker compose exec -T -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" db mysql -uroot chat < backups/chat-<timestamp>.sql
docker compose run --rm db-setup    # re-applies grants and any newer migrations
```

(`MYSQL_ROOT_PASSWORD` must be exported in your shell, for example `set -a; . ./.env; set +a`.)

## Running tests

Tests run inside the `app` container against a separate `chat_test` database. The test helpers refuse to run unless `DB_NAME` ends with `_test`. The live `chat` database is not touched.

```bash
docker compose exec -T -e DB_NAME=chat_test app npm test
```

Lint: `docker compose exec -T app npm run lint` (ESLint 10 flat config in `eslint.config.js`, covering server, src, scripts, test, e2e and public/js).

The suite uses `node:test` and `socket.io-client`. The test helper drops and recreates the tables in the test database from `chat.sql` on every run. It connects as `chat_app`, which has full rights on `chat_test` only.

## End-to-end tests (Playwright)

A browser test suite in `e2e/` drives the real pages (Chromium) against an isolated app instance. It never touches the live `chat` database or the `uploads` volume. Versions: `@playwright/test` 1.56.1 and the image `mcr.microsoft.com/playwright:v1.56.1-noble` (keep them in step).

Last full run: 113 passed, 7 skipped, 0 failed (2.0 min). The skips are by design: the wrong-password test runs only on the desktop-1366 project, and the mobile drawer test runs only on the mobile projects.

```bash
docker compose --profile e2e run --rm e2e                 # starts db, db-setup and app-e2e as needed, then runs the suite
docker compose --profile e2e rm -sf app-e2e e2e           # afterwards: remove ONLY the e2e containers (volumes are kept)
```

- `app-e2e` runs the same image as `app` on database `chat_test` with its own `uploads_e2e` volume, no published ports, and high per-IP limits (all browser traffic shares one IP). Login stays at 5 attempts per minute, so the suite logs in once in `globalSetup` and reuses the session; it makes one deliberate wrong-password attempt.
- `e2e/reset-db.js` recreates the `chat_test` tables from `chat.sql` before each run. It refuses unless `DB_NAME` ends with `_test`.
- Projects (viewports): mobile 375x812, mobile 390x844, tablet 768x1024, desktop 1366x768, desktop 1920x1080. Use `docker compose --profile e2e run --rm e2e bash -c "npm ci && node reset-db.js && npx playwright test --project=mobile-375"` to run one.
- Reports: `e2e/playwright-report/` (HTML) and `e2e/test-results/` (traces and screenshots of failures), both gitignored.
- The `e2e` and `npm test` runs both use `chat_test`: do not run them at the same time.
- The pages load Tailwind and fonts from public CDNs (allowed by the CSP), so the runner needs internet access.

## Common commands

```bash
docker compose logs -f app                        # follow app logs
docker compose ps                                 # list services and health
docker compose up -d --build                      # rebuild and restart
docker compose up -d --build --renew-anon-volumes app   # rebuild and recreate node_modules volume
docker compose exec app npm ci                    # reinstall dependencies if they look stale
docker compose run --rm db-setup                  # re-run user/grants/migrations
docker compose restart app                        # restart app (logs SIGTERM shutdown)
docker compose exec app sh                        # shell into the app container
docker compose exec -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" db mysql -uroot chat   # MySQL prompt (export the root password from .env first)
docker compose down                               # stop and remove containers (keeps db_data)
```

> **Warning:** Never run `docker compose down -v` on a database you want to keep. The `-v` flag deletes the `db_data` volume, and the schema is re-imported from `chat.sql` on the next `up`. All chat data is lost.

## Verify

```bash
curl -I http://localhost:3002/healthz   # chat app: HTTP 200 (healthy)
curl -I http://localhost:3002           # chat app: HTTP 200
docker compose ps -a                    # app and db healthy, db-setup exited 0
```

Open http://localhost:3002 in two browser tabs to exchange messages in real time.

## Remaining risks

See `CODE_REVIEW_REPORT.md` section 8 for the full list and for how each resolved risk was fixed. Still open or by design:
- Tailwind Play CDN (left as requested).
- Read status is per room and shared by all admins (single shared admin login).
- Rate limits, per-IP limits, presence and the upload quota counter are in memory and per process (single instance only).
- Migrations are plain DDL, not transactional in MySQL. Back up first (see Backups).
- Legacy upload copies in `public/attachement` and 2 unreferenced files remain until deleted or pruned.
- The dev database contains QA test chats from browser testing.

## Related documents

- `CODE_REVIEW_REPORT.md`: architecture, findings, fixes and risks
- `TEST_REPORT.md`: test results and verification
- `CHANGELOG.md`: changes, including manual setup steps
