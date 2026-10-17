# chat

A real-time chat application (Node.js + Express + Socket.io with Multer file uploads) backed by MySQL 8, running fully in Docker.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/) v2 (the `docker compose` command)
- Host ports `3002`, `8086`, and `3306` free.

## Run

```bash
docker compose up -d --build
```

The `app` container runs `sleep 15` before starting the server to let MySQL come up. On the **first** boot, MySQL initializes and imports `chat.sql` (~20-40s). Code is bind-mounted and reloaded live via `nodemon`.

## Services

| Service | Image / Build | Purpose | Port (host:container) | URL |
|---------|---------------|---------|-----------------------|-----|
| `chat-app` | Build `.` (`node:18`, Dockerfile) | Express + Socket.io chat server with file uploads | `3002:3000` | http://localhost:3002 |
| `chat-db` | `mysql:8.0` | MySQL database, schema seeded from `chat.sql` on first boot | `3306:3306` | `127.0.0.1:3306` |
| `chat-phpmyadmin` | `phpmyadmin/phpmyadmin` | Web UI for managing the MySQL database | `8086:80` | http://localhost:8086 |

## Environment

Environment variables are defined inline in `docker-compose.yml` (there is no `.env` file). Defaults:

| Service | Variable | Default | Purpose |
|---------|----------|---------|---------|
| `app` | `DB_HOST` | `db` | MySQL hostname |
| `app` | `DB_USER` | `root` | MySQL user |
| `app` | `DB_PASSWORD` | `root` | MySQL password |
| `app` | `DB_NAME` | `chat` | Database name |
| `db` | `MYSQL_ROOT_PASSWORD` | `root` | MySQL root password |
| `db` | `MYSQL_DATABASE` | `chat` | Database created on first boot |
| `phpmyadmin` | `PMA_HOST` | `db` | MySQL host phpMyAdmin connects to |
| `phpmyadmin` | `MYSQL_ROOT_PASSWORD` | `root` | Root password for login |

Log in to phpMyAdmin with user `root` / password `root`.

## Volumes & persistence

- **`db_data`** (named volume) -> `/var/lib/mysql` — persists the MySQL database across restarts. The schema in `chat.sql` is imported only when this volume is first created; removing it (`docker compose down -v`) triggers a re-import on the next `up`.
- **`./chat.sql`** (bind mount) -> `/docker-entrypoint-initdb.d/chat.sql` — schema auto-loaded on first DB boot.
- **`.`** (bind mount) -> `/usr/src/app` — project source mounted into the app container for live reload.
- **`/usr/src/app/node_modules`** (anonymous volume) — keeps the image's `node_modules` from being shadowed by the source bind mount.

## Common commands

```bash
docker compose logs -f app        # follow app logs
docker compose ps                 # list running services
docker compose down               # stop and remove containers (keeps db_data)
docker compose down -v            # also wipe the database volume (schema re-imports next up)
docker compose up -d --build      # rebuild and restart
docker compose exec app sh        # shell into the app container
docker compose exec db mysql -uroot -proot chat   # open a MySQL prompt
```

## Verify

```bash
curl -I http://localhost:3002    # chat app   -> HTTP 200
curl -I http://localhost:8086    # phpMyAdmin -> HTTP 200
docker compose ps                # all three services Up
```

Open http://localhost:3002 in two browser tabs to exchange messages in real time.
