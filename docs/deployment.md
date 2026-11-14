# Deploying Studio Assistant

Two supported shapes:

- **A. One VPS with Docker Compose.** PostgreSQL, the web app and the worker all run on one rented server.
  Media sits on that server's disk. This is the cheapest and simplest option.
- **B. Supabase plus separate hosts.** Supabase provides the database and media storage (S3 protocol). The web
  app runs on Vercel or Fly.io, and the worker runs on Fly.io, Railway or a VPS.

Both shapes run the same two programs, configured only through environment variables (see `.env.example`):

| Program | Image | Needs |
| --- | --- | --- |
| Web app (`apps/web`, Next.js standalone) | `Dockerfile.web` | Node 22, 0.5–1 vCPU, 512 MB–1 GB RAM, database, storage |
| Worker (`apps/worker`, pg-boss jobs + FFmpeg) | `Dockerfile.worker` | Node 22, FFmpeg 6+ with libx264/libass/zscale, **2–4 vCPU, 4 GB RAM**, 10+ GB scratch disk, database, storage |

Renders are CPU-bound. Use dedicated or performance vCPUs for the worker where the provider offers them.
Burstable "shared" CPUs work but get slower once their CPU credit is used up. Keep `WORKER_CONCURRENCY=1` on
2 vCPU and try 2 on 4+ vCPU.

> Nothing here creates paid services. Each provider account, plan and payment method below is opened by the
> owner, or with the owner's explicit approval.
>
> **Verification status.** The images and Compose file in this repository were written and checked in a
> sandbox without a Docker daemon. `docker compose config` was validated, and the exact install and run steps
> each Dockerfile performs were run by hand. No image has actually been built or deployed yet. Provider
> details marked *confirm against provider documentation* come from research notes
> (`docs/research/decisions-summary.md`) and were not re-checked against the live provider pages.

---

## A. Single VPS with Docker Compose (Hetzner, DigitalOcean or similar)

### 1. Server

- **Size:** 4 vCPU / 8 GB RAM / 80+ GB disk is comfortable. 2 vCPU / 4 GB works, but renders take longer.
- **Region:** pick one close to Melbourne for upload speed: Sydney for DigitalOcean (SYD1), Singapore for
  Hetzner (Hetzner has no Australian region). *Confirm regions and current prices against provider
  documentation.*
- **Operating system:** Ubuntu 24.04 LTS. Install Docker Engine with the Compose plugin by following Docker's
  official instructions for Ubuntu.
- **Firewall:** allow only 22 (SSH, preferably limited to your IP), 80 and 443. The database is never
  published, and the web container listens on 127.0.0.1 only.
- **Disk:** media grows by roughly 5–8 GB a month at the planned volume (see `docs/operating-costs.md`). Add a
  block-storage volume and mount it where `./data` lives once the main disk passes about 70 % full.

### 2. First deploy

```bash
git clone <your repository URL> studio-assistant && cd studio-assistant
cp .env.example .env
```

Edit `.env`:

| Variable | Value |
| --- | --- |
| `APP_URL` | `https://studio.example.com.au` (your real https address; it controls the Secure cookie flag and the CSRF origin check) |
| `APP_SECRET` | output of `openssl rand -base64 48` |
| `POSTGRES_PASSWORD` | output of `openssl rand -hex 24` (letters and digits only: it is placed inside a URL) |
| `APP_UID` | `id -u` of the user that owns `./data` on the host (defaults to 1001) |
| `AI_PROVIDER`, `ANTHROPIC_API_KEY` | leave at `none` / blank until the owner approves AI spending |

`DATABASE_URL` in `.env` is ignored by Compose. The containers always connect to the bundled `db` service,
and `QUEUE_DATABASE_URL` must stay commented out. Then:

```bash
mkdir -p data && sudo chown -R "${APP_UID:-1001}" data   # the containers run as this user id
docker compose build
docker compose --profile migrate run --rm migrate        # creates the tables; safe to repeat
docker compose up -d
docker compose ps                                        # web should become "healthy"
curl -s http://127.0.0.1:3000/api/health                 # {"ok":true,"db":true,"queue":true,"storage":"local"}
```

Open `https://<your domain>/setup` (after step 3) and create the owner account. The page only works while no
account exists. You can also create the owner from the command line:

```bash
docker compose --profile migrate run --rm -e OWNER_EMAIL=you@example.com -e OWNER_PASSWORD='at least ten characters' \
  migrate node --import tsx /app/packages/db/src/seed.ts
```

### 3. TLS with Caddy

Caddy obtains and renews Let's Encrypt certificates automatically. Install Caddy from its official Debian or
Ubuntu packages, point your domain's A/AAAA records at the server, then use this `/etc/caddy/Caddyfile`:

```caddyfile
studio.example.com.au {
    encode zstd gzip
    # Uploads arrive in 8 MiB parts; allow a little headroom per request.
    request_body {
        max_size 16MB
    }
    reverse_proxy 127.0.0.1:3000
}
```

`sudo systemctl reload caddy`. Notes:

- Caddy sets `X-Forwarded-For` for the app, which uses it for login rate limiting. Do not publish port 3000
  publicly. A client reaching the app directly could forge that header. *Confirm Caddy's default handling of
  incoming `X-Forwarded-*` headers against Caddy documentation for your version.*
- Long video uploads and downloads stream through Caddy without special settings. Raise timeouts only if you
  see errors on very slow connections.

### 4. Updating (every deploy)

```bash
git pull
docker compose build
docker compose --profile migrate run --rm migrate   # always before starting new code
docker compose up -d                                # recreates web and worker; the worker gets 60 s to stop
```

The worker finishes or hands back running jobs during that 60 s window. pg-boss retries interrupted jobs
automatically, so a deploy during a render only delays it.

### 5. Rollback

Each `docker compose build` replaces the `:local` images. To roll back:

```bash
git checkout <previous tag or commit>
docker compose build && docker compose up -d
```

Migrations only ever add to the schema. Older code keeps working against a newer schema unless a release
note says otherwise. Before any migration that removes or renames something, take a database backup first
(next section). To roll back faster, tag the images before upgrading:
`docker tag studio-assistant-web:local studio-assistant-web:prev` (same for the worker), then point the
`image:` lines back at `:prev`.

### 6. Backups

- **Database:** a nightly logical dump, kept off the server:
  ```bash
  docker compose exec -T db pg_dump -U studio -d studio_assistant -Fc > backups/studio-$(date +%F).dump
  ```
  Restore into an empty database with `pg_restore -U studio -d studio_assistant --clean --if-exists`.
  Copy dumps off the server, for example with `rclone` to object storage. Keep 14 daily and 6 monthly copies.
- **Media (`./data`):** back it up with `restic` or `rclone sync` to object storage, or use the provider's
  server snapshots or backups. *Confirm the cost of snapshots or backups against provider documentation; it is
  often a percentage of the server price.*
- **Test a restore** into a scratch server at least once before relying on it.

### 7. Monitoring

- `GET /api/health` returns `{ ok, db, queue, storage }`, or HTTP 503 when something is down. Point a free
  uptime checker (UptimeRobot, Better Stack or similar) at `https://<domain>/api/health`.
- Logs: `docker compose logs -f web worker`. Both write JSON lines (pino), and secrets are redacted. Docker
  rotates logs only if configured to: set `"log-opts": {"max-size": "20m", "max-file": "5"}` in
  `/etc/docker/daemon.json`.
- The worker logs `worker started` with all seven queues at boot. Job progress and failures are also visible
  in the app (Video Studio job list) and in the `jobs` table.
- Watch disk space (`df -h`). A full disk stops uploads and renders.

---

## B. Supabase + separate hosts

### 1. Supabase project

Recommended in `docs/research/decisions-summary.md`:

- **Pro plan**, project in **Sydney (ap-southeast-2)**, Micro compute, Spend Cap on.
- The Free plan is only suitable for development. It caps a single file at 50 MB, pauses inactive projects
  and includes very little storage.
- *Confirm plan limits and prices against Supabase documentation.*

From the dashboard's **Connect** dialog, copy the connection strings:

| Use | Connection | Port |
| --- | --- | --- |
| Worker (`DATABASE_URL` and `QUEUE_DATABASE_URL`) | Direct connection (needs IPv6 from the worker host) **or** shared pooler in **session mode** | 5432 |
| Migrations | Same as the worker (never the transaction pooler) | 5432 |
| Web app on a long-running host (Fly.io, VPS) | Same as the worker | 5432 |
| Web app on serverless (Vercel), if desired | Shared pooler in **transaction mode**, small pool | 6543 |

- **pg-boss** (the job queue) keeps long-lived connections and advisory locks, so the worker must use a
  session-mode or direct connection.
- **Transaction mode** works for the web app's queries. It must not be used with named prepared statements,
  and the app does not use them. *Confirm pooler host names and modes against Supabase documentation.*
- Add `?sslmode=require` to connection strings and turn on **Enforce SSL** in the database settings.
- **Connection budget:** Micro allows about 60 Postgres connections in total, and the session pooler about 15
  per role (research figures). The worker opens up to 8 (database pool) + 6 (queue). The web app opens up to
  10 + 3. That fits a direct connection. If the session pooler refuses connections, raise the pool size in the
  database settings, or run the web app over the transaction pooler.

### 2. Media storage: Supabase Storage via the S3 protocol

1. In **Storage**, create a **private** bucket (for example `studio-media`). Set a per-bucket file size limit
   that fits phone videos (several GB). Raise the global file size limit in **Storage settings** if needed,
   since the Pro plan allows large files.
2. In **Storage → S3 Connection** (Storage settings), enable the S3 protocol and **create an access key**.
   These keys bypass row-level security: keep them server-side only (worker and web environment variables).
3. Set:
   ```env
   STORAGE_DRIVER=s3
   S3_ENDPOINT=https://<project-ref>.storage.supabase.co/storage/v1/s3
   S3_REGION=ap-southeast-2          # the region shown on the S3 connection page
   S3_BUCKET=studio-media
   S3_ACCESS_KEY_ID=...
   S3_SECRET_ACCESS_KEY=...
   S3_FORCE_PATH_STYLE=true
   ```
   The dashboard may show the endpoint as the project URL form (`https://<project-ref>.supabase.co/storage/v1/s3`).
   Use exactly what the S3 connection page shows. *Confirm against Supabase documentation.*
4. Browsers only ever receive short-lived presigned links (`MEDIA_LINK_TTL_SECONDS`, default 1 hour).

**Egress and the R2 alternative.** The worker downloads original footage again for every export, and the owner
downloads the finished MP4s, so media egress adds up. The research recommends **Cloudflare R2** for media,
because R2 has no egress charges:

```env
S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_FORCE_PATH_STYLE=true
```

With R2, use a private bucket with location hint Oceania and an API token scoped to Object Read & Write on that
bucket. At the volumes in `docs/operating-costs.md`, Supabase's included egress is enough, so either works.

### 3. Web app

- **Fly.io (simplest, same image):** deploy `Dockerfile.web`, set the secrets with `fly secrets set`,
  use internal port 3000, and set a health check on `/api/health`. One shared-CPU machine with 1 GB RAM is
  enough.
- **Vercel:** set the project's root directory to `apps/web`. The build command is `pnpm --filter @studio/web
  build` (it uses webpack, see `apps/web/README.md`). Use the Sydney region and the transaction-pooler URL.
  - The upload part size (8 MiB) is larger than Vercel's documented request-body limit for functions, so
    uploads would fail there unless the upload path changes, for example to direct-to-bucket presigned uploads.
    **Prefer Fly.io or a VPS for the web app until that change is made.** *Confirm current limits against
    Vercel documentation.*
  - Vercel's Hobby plan is for non-commercial use, so a business needs a paid plan.
- Set `APP_URL` to the public https address.

### 4. Worker

The worker needs FFmpeg 6+ and real CPU. Deploy `Dockerfile.worker`, which uses Debian 13, ships FFmpeg 7.x
and checks the required filters when the image is built.

- **Fly.io:** a machine with 2–4 performance vCPUs and 4–8 GB RAM. No public ports. Set a kill timeout of at
  least 60 s so running jobs can stop cleanly. Keep one machine always running, because the worker polls the
  queue and cannot scale to zero by itself. *Confirm machine sizes and prices against Fly.io documentation.*
- **Railway:** deploy from `Dockerfile.worker` with the same variables and a service with enough CPU. *Confirm
  plan limits against Railway documentation.*
- **VPS:** run only the `worker` service from `docker-compose.yml`, with `DATABASE_URL`/`QUEUE_DATABASE_URL`
  pointing at Supabase. Remove the Compose `DATABASE_URL` override in a small `docker-compose.override.yml`
  (or run the image with `docker run --init --env-file .env`).
- Scratch space: `WORKER_TMP_DIR` needs several GB free during an export. Mount a volume there on Fly.io.

### 5. Migrations on deploy

Run migrations **once per release, before the new web and worker start**, over the direct or session
connection:

```bash
# from a checkout with dependencies installed
DATABASE_URL='postgresql://...:5432/postgres?sslmode=require' pnpm db:migrate
# or with the worker image
docker run --rm -e DATABASE_URL='postgresql://...' -w /app/apps/worker studio-assistant-worker \
  node --import tsx /app/packages/db/src/migrate.ts
```

On Fly.io this can be a `release_command` for the worker app. Migrations are tracked in
`__drizzle_migrations` and are safe to repeat.

### 6. Backups, monitoring, rollback (Supabase path)

- **Database:** Supabase Pro includes daily backups (point-in-time recovery is a paid add-on). Also keep your
  own weekly `pg_dump -Fc` off-platform. *Confirm retention against Supabase documentation.*
- **Media:** Supabase Storage objects are not versioned, so deleted files cannot be recovered. Sync the bucket
  to a second location with `rclone` if the owner wants a media backup.
- **Monitoring:** uptime check on `/api/health`, plus the host's log viewer (`fly logs`, Railway logs,
  `docker compose logs`).
- **Rollback:** redeploy the previous image or release (`fly deploy --image <previous>`, or Fly's
  release history). Database changes are additive, as in path A.

---

## Secrets handling (both paths)

- Secrets live only in `.env` on the server (mode `600`, never committed) or in the host's secret store (Fly
  secrets, Railway variables, Vercel environment variables). Images contain no secrets: `.dockerignore`
  excludes `.env*`.
- `APP_SECRET` signs sessions and media links, and by default it also derives the key that encrypts
  integration tokens. Rotating it signs everyone out and makes stored integration tokens unreadable unless
  `APP_ENCRYPTION_KEY` is set separately. Set `APP_ENCRYPTION_KEY` (`openssl rand -base64 32`) before connecting
  any integration.
- S3 keys, the Anthropic key and the Square/Meta/TikTok/Google secrets go only to the processes that use them.
  Today that is both web and worker, because they share one configuration.
- Paid services (Anthropic API, Supabase Pro, Fly.io, R2 beyond its free tier) are only switched on after the
  owner approves the spending. With `AI_PROVIDER=none` the app makes no paid API calls.

## Checklist before go-live

- [ ] `APP_URL` is the https address; sign-in works and the cookie is marked Secure.
- [ ] `/api/health` reports `ok: true`; the uptime check is configured.
- [ ] A real clip uploads, five previews render, and an export downloads and plays on a phone
      (see the acceptance checklist in `docs/testing.md`).
- [ ] Nightly database backup runs and a restore has been tested.
- [ ] Disk or bucket usage is being watched against `docs/operating-costs.md`.
