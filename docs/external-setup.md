# Remaining external setup

Everything here needs an account, a credential or a console that was not available while this was
built. None of it has been done, and none of the integrations below have been verified against the
real service. See [verification.md](verification.md) for what was verified locally, and how.

## 1. Merge the existing-repository changes

| Repository | Branch | Pull request |
| --- | --- | --- |
| `streamlineos-backend` | `feat/blog-shared-publication` | [Startupppp/streamlineos-backend#83](https://github.com/Startupppp/streamlineos-backend/pull/83) |
| `streamlineos-frontend` | `feat/blog-shared-publication` | [Startupppp/streamlineos-frontend#230](https://github.com/Startupppp/streamlineos-frontend/pull/230) |
| `Startupppp/blogs` (this) | `blog/post-audit-fixes` | [Startupppp/blogs#1](https://github.com/Startupppp/blogs/pull/1) |

Merge the backend first, deploy it, then the frontend (rollout order in [runbook.md](runbook.md)).
Both branches carry a merge of `origin/main`, so they are current as of 1 October 2026.

## 2. Database

The PRD assumes Neon. The backend's configured database is PostgreSQL on AWS RDS
(`ap-south-1`); the admin works with either, as long as it points at **the same database** the
backend uses in that environment.

1. Apply migration `1705_blog_revisions_publication` through the backend's migration runner, on
   staging first, then production. It could not be applied from this machine (no access to the
   production AWS account).
2. Run `db/provision-editorial-role.sql` as the database owner (see the runbook). `blog_admin_app`
   uses password authentication; on RDS, do **not** grant it `rds_iam`, or password sign-in stops.
3. Allow the admin's hosting egress to reach the database (RDS security group / public access,
   or a Neon IP allowlist if used). Connections use TLS (`DATABASE_SSL=require`).
4. Insert the first administrator row (`blog_editors`).
5. Confirm backup retention for the plan in use and record it in the runbook.

## 3. Google sign-in

Create an OAuth 2.0 client (type *Web application*) for the admin only, in the Google Cloud project
Streamline OS already uses for sign-in:

- Authorised JavaScript origin: `https://<admin-host>`
- Authorised redirect URI: `https://<admin-host>/api/auth/callback/google`
- Set `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_URL=https://<admin-host>`, `AUTH_SECRET`.

## 4. Cloudflare R2

1. Two buckets in the Streamline OS account, for example `streamline-blog-private` and
   `streamline-blog-public`. Do **not** reuse a bucket that holds HR or business documents.
2. An R2 API token with *Object Read & Write* on those two buckets only →
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. `R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`.
3. Private bucket: no public access, no custom domain. CORS, so browsers can PUT presigned uploads:

   ```json
   [
     {
       "AllowedOrigins": ["https://<admin-host>"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["content-type"],
       "MaxAgeSeconds": 600
     }
   ]
   ```

4. Public bucket: connect a custom domain (for example `media.streamlineos.in`) with TLS. That
   origin is `MEDIA_PUBLIC_ORIGIN` in the admin and `NEXT_PUBLIC_BLOG_MEDIA_ORIGIN` in the
   frontend (it is added to the frontend CSP `img-src`).
5. Then run one real upload → publish → view cycle on staging. The local runs used an in-memory
   S3 stand-in that does not verify signatures or CORS.

## 5. Admin hosting (Vercel)

1. Import `Startupppp/blogs` as a new project (framework Next.js, root `/`).
2. Set every variable in `.env.example` for Production and Preview (Preview pointing at staging).
   `R2_ENDPOINT` and `MEDIA_PUBLIC_ORIGIN` are also read at **build** time for the CSP.
3. Assign the admin domain, and set `ADMIN_ORIGIN` and `AUTH_URL` to exactly that origin.
4. The cron in `vercel.json` runs every minute; that needs a Vercel plan that allows per-minute
   crons (Hobby allows only daily). Set `CRON_SECRET`. Without the cron, scheduled posts do not
   publish and failed notifications are not retried.
5. Protect Preview deployments (Vercel deployment protection); the app already sends
   `X-Robots-Tag: noindex` everywhere.

## 6. Backend and frontend configuration

| Variable | Service | Value |
| --- | --- | --- |
| `BLOG_INVALIDATION_SECRET` | backend and admin | Same random value (≥ 32 chars) on both |
| `BLOG_INVALIDATION_SECRET_PREVIOUS` | backend | Only during rotation |
| `BLOG_SITE_ORIGIN` | backend | Canonical public origin used in RSS links |
| `BLOG_INVALIDATION_URL` | admin | `https://<api-host>/blog/internal/invalidate` |
| `NEXT_PUBLIC_BLOG_MEDIA_ORIGIN` | frontend | The public media domain (https) |
| `BLOG_ADMIN_URL` | frontend | The admin origin; the old `/blog/admin` page redirects there |

## 7. Search and launch checks

- Search Console: verify the site property and submit `/sitemap.xml` (site owner).
- On staging, check canonical links, redirects, `/sitemap.xml`, `/blogs/rss.xml` and `robots.txt`
  on the deployed origin, and that the admin origin is not indexed.
- Replace the development cover image and write reviewed launch articles; nothing from fixtures or
  the local runs is published anywhere.
