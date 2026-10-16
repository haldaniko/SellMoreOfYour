# SellMoreOfYour

Full-stack SellMoreOfYour publishing platform with a Vite React frontend, secure Express backend, admin publishing, OpenRouter AI generation, and Docker dev/prod environments. Development uses PostgreSQL; production uses a host SQLite file after a one-time automatic migration.

## Stack

- Frontend: Vite, React, TypeScript, SCSS
- Backend: Node.js, Express, TypeScript
- Database: PostgreSQL in development, SQLite in production
- Service dependency: Redis
- AI: OpenRouter API
- Newsletter: Nodemailer-ready SMTP env
- Infra: Docker, Docker Compose

## Project Structure

- `backend/src/index.ts` wires middleware, routes, schema bootstrap, scheduler, and error handling.
- `backend/src/routes/*` contains API modules.
- `backend/src/services/*` contains database stores, auth, OpenRouter, sanitization, audit logging, and scheduler logic.
- `frontend/src/App.tsx` contains the Vite SPA router, pages, admin UI, and reusable UI sections.
- `frontend/src/styles.scss` contains the SellMoreOfYour dark editorial visual system.

Production runtime data lives in `./db.sqlite3` on the Linux host. Local sample posts are in `backend/src/data/samplePosts.ts` and are inserted into an empty development PostgreSQL table only.

## Local Docker

Copy env templates if needed:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Preferred local rebuild command, avoiding Docker Desktop BuildKit/Bake hangs:

```bash
npm run docker:rebuild
```

It runs classic Docker builds for backend and frontend, then starts Compose with `--no-build`.

Standard Compose also exists:

```bash
docker compose up -d --build
```

If that hangs on `load local bake definitions` or `listing workers`, use `npm run docker:rebuild`.

Services:

- Frontend: http://localhost:3000
- Backend: http://localhost:4000/api/health
- Admin: http://localhost:3000/admin

The `admin-seed` service creates/updates a local admin and may exit with code `0`. Defaults:

- Email: `admin@sellmoreofyour.local`
- Password: `MySecretPassword123!`

Override with `LOCAL_SUPERADMIN_EMAIL` and `LOCAL_SUPERADMIN_PASSWORD`.

To create a superadmin manually:

```bash
cd backend
LOCAL_SUPERADMIN_EMAIL=admin@sellmoreofyour.local LOCAL_SUPERADMIN_PASSWORD='replace-me' npm run create-superadmin
```

## OpenRouter

Set `OPENROUTER_API_KEY` in `.env`, `backend/.env`, or the production env file. The default model is:

```bash
OPENROUTER_MODEL=meta-llama/llama-3.1-8b-instruct
```

The master prompt is seeded from `backend/src/data/masterPrompt.ts`, stored in the `admin_settings` table, and editable from `/admin` under AI generation settings.

## Auth

Admin users are stored in the configured database. The app stores only `password_hash`, never plain passwords.

Auth uses:

- bcrypt password hashing
- short-lived JWT access token
- httpOnly refresh cookie
- hashed refresh tokens in the database
- CSRF token check on refresh
- rate limiting on auth endpoints
- audit events for auth, settings, posts, and generation

Do not use env-based admin passwords for runtime login.

## Production Secrets

Generate secrets:

```bash
npm run generate-secrets
npm run setup:prod-env
```

Keep these stable across deploys:

- `JWT_SECRET`
- `REFRESH_TOKEN_SECRET`
- `POSTGRES_PASSWORD`

Changing them logs admins out or changes database access.

## Production PostgreSQL to SQLite cutover

The existing production Compose project must be run from the same project directory and with the same Compose project name as before. The volume key `sellmoreofyour_prod_postgres_data` is deliberately unchanged. Keep the existing root `.env` (with `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `VITE_API_URL`, and admin settings) and `backend/.env.production` (JWT secrets and URLs). Do not commit either file.

**Back up before updating the code.** In a maintenance window, from the existing project root on the server:

```bash
set -euo pipefail
mkdir -p backups
docker compose -f docker-compose.prod.yml stop frontend backend admin-seed
docker compose -f docker-compose.prod.yml exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backups/postgres-before-sqlite.dump
docker compose -f docker-compose.prod.yml stop postgres
pg_container=$(docker compose -f docker-compose.prod.yml ps -a -q postgres)
test -n "$pg_container"
pg_volume=$(docker inspect "$pg_container" --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}')
pg_project=$(docker inspect "$pg_container" --format '{{index .Config.Labels "com.docker.compose.project"}}')
test -n "$pg_volume" && test -n "$pg_project"
docker run --rm -v "$pg_volume:/source:ro" -v "$PWD/backups:/backup" alpine:3.20 tar -czf /backup/postgres-volume-before-sqlite.tar.gz -C /source .
for file in .env .env.production backend/.env.production db.sqlite3; do
  if test -e "$file"; then cp -a --parents "$file" backups/; fi
done
if test -d media; then cp -a media backups/; fi
if test -d backend/media; then cp -a --parents backend/media backups/; fi
if test ! -f .env && test -f .env.production; then cp -a .env.production .env; fi
test -f .env
if ! grep -q '^COMPOSE_PROJECT_NAME=' .env; then printf '\nCOMPOSE_PROJECT_NAME=%s\n' "$pg_project" >> .env; fi
```

If the old deployment supplied Compose variables only through `--env-file .env.production`, use that same option for the backup commands above. The backup step copies that file to root `.env`; the one-command launch then reads it automatically. Preserve `backend/.env.production` separately.

Keep `backups/` outside the Git checkout when replacing the directory. Then update the code **in the same directory** and run exactly:

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

The `migrate-db` service starts the original PostgreSQL volume, checks all six application tables, blocks future writes to PostgreSQL, copies rows into a temporary file in the project root, verifies counts, content hashes, SQLite integrity and foreign keys, and atomically publishes `./db.sqlite3`. The backend starts only after this service exits successfully. Repeating the command validates and retains the existing SQLite file; it never imports PostgreSQL over newer SQLite records. A failed or unrecognized SQLite file prevents startup. Inspect migration output with `docker compose -f docker-compose.prod.yml logs migrate-db`.

The backend runs as the owner of the project directory, and SQLite uses DELETE journaling. That directory must be writable by its owner because SQLite briefly creates a `db.sqlite3-journal` file there. The database file is mode `0600`. Back up `db.sqlite3` with SQLite's backup API or while the backend is stopped; keep the old PostgreSQL volume until the cutover has been verified. PostgreSQL is left read-only as a rollback safeguard. To resume PostgreSQL after a deliberate rollback, restore the previous Compose code, then run `SET default_transaction_read_only = off` and `ALTER DATABASE <database_name> RESET default_transaction_read_only` in the same PostgreSQL session as the database owner.

There is no upload API or media volume in this project. The existing `backend/media` contains only `.gitkeep`; article covers and avatars are static files in `frontend/public` served at `/covers/...` and `/avatars/...`. No production media copy is required by the current application.

Production ports:

- Frontend: host `8080` -> container `3000`
- Backend: host `4000` -> container `4000`
- PostgreSQL and Redis are internal only. PostgreSQL remains available for the migration and rollback.

Backend refuses to start in production if required secrets are missing, equal, too short, or production URLs still point to localhost.

## API Summary

- `GET /api/health`
- `GET /api/posts`
- `GET /api/posts/search?q=term`
- `GET /api/posts/:slug`
- `POST /api/subscribe`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET /api/admin/posts`
- `POST /api/admin/posts`
- `PUT /api/admin/posts/:slug`
- `DELETE /api/admin/posts/:slug`
- `GET /api/admin/settings`
- `PUT /api/admin/settings`
- `POST /api/ai/generate-article`

## Backups

Back up the production `db.sqlite3` and keep the original PostgreSQL volume backup. Never use `docker compose down -v` during a migration or rollback.
