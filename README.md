# Streamline OS blog admin

The editorial CMS for the Streamline OS Journal. Editors write, review, schedule and publish here;
articles appear on the existing Streamline OS site at `/blogs` with no rebuild of that site.

- Next.js 16 (App Router, Node runtime), React 19, TypeScript, Tailwind 4
- Drizzle + postgres-js against the **same** database the Streamline OS backend uses, through a
  scoped role that can touch blog tables only
- Cloudflare R2 (private originals, public published renditions), Sharp for image processing
- Auth.js with Google; access only through explicit editorial assignments
- No separate API server: Server Actions, Route Handlers and server-only services do the work

How it fits with the other repositories: [docs/architecture.md](docs/architecture.md).

## Requirements

- Node.js 22 or newer, pnpm 10
- PostgreSQL with the backend's migrations applied through
  `1703_blog_revisions_publication` (the backend owns every schema change; this app never migrates)

## Run locally

```bash
pnpm install
cp .env.example .env.local        # then fill in values; see the comments in the file
pnpm dev:object-store             # in-memory S3 stand-in on :9000 (instead of R2)
pnpm dev                          # http://localhost:3100
```

For the object store, set `R2_ENDPOINT=http://127.0.0.1:9000`, `R2_FORCE_PATH_STYLE=true` and
`MEDIA_PUBLIC_ORIGIN=http://127.0.0.1:9000/<R2_PUBLIC_BUCKET>`.

Database access for local work:

```bash
# as the database owner, once per database
psql "$OWNER_DATABASE_URL" -v admin_password=dev-only-password -f db/provision-editorial-role.sql
psql "$OWNER_DATABASE_URL" -c "insert into blog_editors (email, role) values ('you@example.com', 'admin')"
```

Then `DATABASE_URL=postgres://blog_admin_app:dev-only-password@localhost:5432/<db>` and
`DATABASE_SSL=disable`. Sign-in needs a Google OAuth client with the redirect URI
`http://localhost:3100/api/auth/callback/google`.

To see published articles, run `streamlineos-backend` and `streamlineos-frontend` against the same
database, with the same `BLOG_INVALIDATION_SECRET` on the backend and here.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js on port 3100 |
| `pnpm dev:object-store` | Local S3 stand-in (never a production substitute) |
| `pnpm lint` / `pnpm type-check` | ESLint / TypeScript |
| `pnpm test` | Unit tests (content model, renderer, slugs, schedule times, editor JSON) |
| `pnpm test:db` | Database tests. Drops and rebuilds `blog_admin_test` (override with `TEST_OWNER_DATABASE_URL`; it refuses any host but localhost and any name not ending in `_test`), then runs as the scoped role |
| `pnpm check:schema-vendor` | Fails if `db/test-schema/` differs from the backend's migrations (`BACKEND_DIR`, default `../streamlineos-backend`) |

## Deploy

Vercel, one project for this repository. The full order (backend migration, public readers,
database role, first administrator, admin, scheduler) and rollback are in
[docs/runbook.md](docs/runbook.md). Everything that still needs an account or console is in
[docs/external-setup.md](docs/external-setup.md).

- Set every variable in `.env.example`. `ADMIN_ORIGIN` and `AUTH_URL` must be the same origin.
- `vercel.json` registers a per-minute cron for `/api/jobs/run` (scheduled publishing, media
  processing, site notifications, media cleanup). It sends `CRON_SECRET` as a bearer token.
- `GET /api/health` reports readiness, the supported schema version and the job backlog.

## Documentation

- [Architecture](docs/architecture.md)
- [Runbook](docs/runbook.md): rollout, rollback, backup and restore, media cleanup, editorial use
- [Content migration](docs/content-migration.md): existing posts and legacy articles
- [Verification](docs/verification.md): requirement matrix, command results, the cross-app run
- [Remaining external setup](docs/external-setup.md)
- [Discovery](docs/discovery.md): what the existing repositories looked like before this work
