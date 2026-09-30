# Discovery inventory

Recorded 2026-09-30 before any behaviour change. Sources are `origin/main` of each repository, read
with `git show`, not a working tree (both working trees were on another session's branch with
uncommitted work).

## Canonical repositories

| Repository | Local path | Remote | Role |
| --- | --- | --- | --- |
| Backend (NestJS) | `streamlineos-backend/` | `Startupppp/streamlineos-backend` | Public blog read API, migration owner |
| Frontend (Next.js) | `streamlineos-frontend/frontend/` | `Startupppp/streamlineos-frontend` | Public `/blogs` site |
| Blog admin (this repo) | `streamlineos-blog-admin/` | `Startupppp/blogs` | Editorial CMS (new) |

## Package scripts that matter here

- Backend: `pnpm typecheck` (needs a 12 GB heap), `pnpm test`, `pnpm test:db-specs`,
  `pnpm db:migrate`, `pnpm openapi:generate`, `pnpm check:migration-discipline`,
  `pnpm check:migration-chain`, `pnpm lint`.
- Frontend: `pnpm type-check`, `pnpm lint`, `pnpm build` (`next build --webpack`), `pnpm test`,
  `pnpm check:routes`, `pnpm check:seo-metadata`, `pnpm check:command-catalog`,
  `pnpm check:response-contracts`.

## Current public URLs

| URL | Behaviour on `origin/main` |
| --- | --- |
| `/blogs` | Renders an empty feed (`initialPosts={[]}`), a fake newsletter form that only shows a toast |
| `/blogs/[postSlug]` | Reads `features/blog/data/posts.ts` (one hard-coded fixture) and renders "Blog post content unavailable." |
| `/blogs/category/[categorySlug]` | Empty feed, then client-side infinite scroll against `/blog/feed` |
| `/blogs/tag/[tag]` | Same, filtered by tag |
| `/sitemap.xml` | Lists the fixture post, not database posts |
| `/blog/admin` (authenticated) | Old Tiptap admin, writes through the NestJS admin API |

No archive, author, search, editorial-policy or RSS route exists.

## API contracts

The backend uses URI versioning (`configureApiVersioning`) and the frontend calls it through
`NEXT_PUBLIC_API_URL` / `API_INTERNAL_URL` with paths such as `/blog/feed`.

Public (all `@Public()`, rate-limited `blog:public-read` at 60/min):
`GET /blog/feed`, `GET /blog/categories`, `GET /blog/by-slug/:slug`,
`GET /blog/by-slug/:slug/adjacent`.

Admin (`JwtAuthGuard` + `PermissionGuard`): `GET|POST /blog/admin/posts`,
`GET|PATCH|DELETE /blog/admin/posts/:postId`, `GET|POST /blog/admin/categories`,
`PATCH|DELETE /blog/admin/categories/:categoryId`.

Defects found in the public contract:

- `GET /blog/by-slug/:slug` returns the full row, including `author.email`, `contentJson` and
  `status` (PUB-08).
- Publication is `status = 'published'` only. `publishedAt` is not compared with `now()`, so a
  future-dated row would be public.
- Feed order is `published_at DESC` with no id tie-breaker, and the cursor is the timestamp
  alone, so equal timestamps drop or duplicate posts across pages.
- `PATCH /blog/admin/posts/:postId` writes straight onto the public row: there is no draft of a
  published post. Renaming a post silently changes its slug, with no redirect.
- `PATCH /blog/admin/categories/:categoryId` re-slugs a category on rename, breaking its URL.

## Permissions

`blog:posts:manage`, `blog:categories:manage`, `blog:ai:use` are global keys in
`src/common/rbac/grantability.ts`. Access policy restricts global blog administration to the
user ids in `PLATFORM_OPERATOR_USER_IDS`, so a customer organisation administrator cannot reach
the old admin. The new admin does not reuse these keys; it has its own explicit editorial
assignments (`blog_editors`), see `docs/architecture.md`.

## Storage taxonomy

The backend has ONE general bucket (`R2_BUCKET_NAME`, public URL `NEXT_PUBLIC_R2_PUBLIC_URL`)
holding avatars, blog images, candidate documents, payslips and exports under folder prefixes,
plus `R2_KB_BUCKET_NAME`. That bucket holds private HR data, so it must never be made public
and the blog admin must never receive credentials for it. The admin uses two new buckets:
a private upload/originals bucket and a public delivery bucket.

## Migrations

Hand-authored SQL in `streamlineos-backend/migrations/`, journalled in
`migrations/meta/_journal.json`; a `.sql` that is not journalled never runs. Blog tables were
created in `0000_light_vance_astro.sql`; `0843` added the full-text GIN index on
`title || ' ' || excerpt`. The backend remains the single migration owner.

## Content rendering

`blog_posts.content` is HTML produced by the old Tiptap admin (`content`) alongside
`content_json`. Nothing on the public site currently renders it.

## Cache layers

- Backend: `CacheService.cachedVersioned` is used only for the ADMIN post list
  (`blog:admin:posts`). Public reads are uncached database reads.
- Frontend: every blog route is `force-dynamic`; the only public server fetch helper that exists
  is `lib/public-fetch.ts` (`publicGet` revalidates at 60 s; `publicGetNoStore` is no-store).

## Deployment platform

Frontend: Vercel (`frontend/vercel.json`, `pnpm build`). Backend: Dockerfile. The backend
`.env` now names an AWS RDS instance with IAM auth, not Neon; production is in a separate AWS
account that this machine cannot reach. Whether production still runs on Neon is unverified.

## Existing content: real or fixture

- The only visible post is a code fixture (`features/blog/data/posts.ts`, "Why we built
  StreamlineOS"). It is NOT promoted to the database.
- The production `blog_posts` contents could not be read from this machine. The migration
  therefore backfills whatever rows exist, without assuming they are fixtures or real.
