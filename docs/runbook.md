# Runbook

## Rollout order (first release)

Each step must be finished and checked before the next.

1. **Backend migration.** Apply `1703_blog_revisions_publication` with the backend's own migration
   runner, once, against the environment's database. Check:
   `select version from blog_schema_meta` returns `2`.
2. **Backend and frontend.** Deploy `streamlineos-backend` and `streamlineos-frontend` from
   `feat/blog-shared-publication` (public reads, invalidation receiver, redesigned `/blogs`). Set
   `BLOG_INVALIDATION_SECRET` and `BLOG_SITE_ORIGIN` on the backend and
   `NEXT_PUBLIC_BLOG_MEDIA_ORIGIN` and `BLOG_ADMIN_URL` on the frontend. Existing articles keep
   rendering from their legacy columns.
3. **Database role.** As the database owner:
   `psql "$OWNER_DATABASE_URL" -v admin_password="$(openssl rand -base64 36)" -f db/provision-editorial-role.sql`.
   Put the resulting `blog_admin_app` URL in the admin's `DATABASE_URL`.
4. **First administrator.** As the owner:
   `insert into blog_editors (email, role) values ('<google-account-email>', 'admin');`
   The first Google sign-in with that address binds the account. Add everyone else from the
   **Editors** page.
5. **Admin.** Deploy this repository (see README) with every variable in `.env.example`. Check
   `GET /api/health` returns `{"status":"ready"}`.
6. **Scheduler.** Confirm the Vercel cron for `/api/jobs/run` is registered and `CRON_SECRET` is set
   (Vercel sends it as a bearer token). `/api/health` → `jobs.due` should stay near 0.

## Deploying later changes

- A change that needs a new shared column: backend migration first (bump `blog_schema_meta.version`
  if what the admin writes changes), then the public readers, then the admin with the new version
  added to `SUPPORTED_SCHEMA_VERSIONS`. Copy the migration into `db/test-schema/` and run
  `BACKEND_DIR=../streamlineos-backend pnpm check:schema-vendor`.
- An admin-only change: deploy the admin. Vercel keeps the previous deployment for instant rollback.

## Rollback

| What | How |
| --- | --- |
| Admin deployment | Promote the previous Vercel deployment. Content already published stays published. |
| Stop all editorial writes now | `psql "$OWNER_DATABASE_URL" -f db/revoke-editorial-role.sql` (disables `blog_admin_app`, ends its sessions). The public site is unaffected. Undo by re-running the provisioning script. |
| Frontend / backend | Redeploy the previous build. The previous backend reads the legacy columns, which 1703 keeps as the published projection, so it serves the same articles. |
| Migration 1703 | Forward repair is preferred. `migrations/rollback/1703_blog_revisions_publication.down.sql` drops only what 1703 added (revisions, editors, media records, jobs, audit, the new columns). **It discards revision history and editorial media records**; take a backup first and only use it before the admin has been used for real work. |

## Backup and restore

- Postgres point-in-time restore is the content backup. Its retention depends on the database
  plan in use; confirm it before launch and note it here. A logical export of just the blog data:
  `pg_dump "$OWNER_DATABASE_URL" -t 'blog_*' -Fc -f blog-$(date +%F).dump`.
- R2 is **not** covered by a database restore. After restoring the database, reconcile media:
  every `blog_media` row with `status = 'ready'` must have its `variants[].key` objects in the
  private bucket, and every row with `promoted_at` set must have them in the public bucket.
  Missing objects must be re-uploaded; the article publish check will block until they are.
- Restoring an older database can resurrect withdrawn posts. After a restore, review
  `select slug from blog_posts where status = 'published'` against what should be live.

## Media cleanup

Runs on every job-runner tick (`sweepMedia`, bounded batches, audited as `media.cleanup` and
`media.orphan_unpublish`):

- uploads never finalised are removed after 1 day;
- failed images referenced by nothing are removed after 7 days;
- public copies that no revision references are withdrawn after 1 day.

**Unpublishing a post does not delete its images.** Public image URLs are content-addressed and
cached for a year, and anyone may already have copied them. To stop serving an image, open it in
**Media → Remove public copies**; that is refused while a published or scheduled post still
uses it. Then
purge the URL in the Cloudflare cache for the media domain. Deleting a media item is only allowed
when nothing references it.

## Editorial usage

- **Posts → New post** creates a draft assigned to you. The editor autosaves after 1.5 s idle; the
  status line shows Saving / Saved / Not saved. If a save fails, changes stay in the browser and
  are offered back when the post is reopened.
- **Check before publishing** lists blocking problems beside their fields and non-blocking advice
  (missing credit, SEO lengths, broken internal links). **Publish now** is enabled only when nothing
  blocks.
- After publishing, the panel shows **Published. The website is being updated.** and then
  **Live on StreamlineOS** once the public page shows the new revision. If it stays on updating,
  see Operations.
- Editing a published post changes only the draft; the site keeps the published version until
  **Publish changes**. **History** lists revisions; restoring one creates a new draft revision
  and never republishes by itself.
- **Schedule** takes a local time in your time zone (ambiguous or skipped daylight-saving times
  must be chosen explicitly). **Cancel schedule** stops it even if the job has already started.
- Changing the URL of a published post creates a redirect from the old address when published.
- **Unpublish** removes the article from the site, search, feed and sitemap immediately.
  **Restore as draft** brings it back for editing; it stays off the site until published.

## Editorial access

- Add, re-role or disable editors on **Editors** (admins only). Access is checked on every request,
  so disabling someone takes effect on their next click.
- Revoking one person's Google account elsewhere does not end an 8-hour admin session; disable
  them on **Editors** as well.

## Secrets rotation

| Secret | Rotation |
| --- | --- |
| `BLOG_INVALIDATION_SECRET` | Set the new value as the backend's `BLOG_INVALIDATION_SECRET` and the old one as `BLOG_INVALIDATION_SECRET_PREVIOUS`; deploy the backend; then set the new value in the admin; later remove the previous secret. |
| `AUTH_SECRET` | Changing it signs everyone out. |
| `CRON_SECRET` | Update in Vercel; the next cron call uses it. |
| R2 keys | Create a new token scoped to the two editorial buckets, update the admin, revoke the old token. |
| `blog_admin_app` password | `alter role blog_admin_app password '…'` as owner, then update `DATABASE_URL`. |

## Operations and alerts

- `GET /api/health`: `status` (ready / unready), `jobs.due`, `jobs.dead`, `jobs.oldest_secs`.
  Alert when unready, when `oldest_secs` exceeds 300, or when `dead` rises.
- **Operations** page: queued, failed and dead jobs with **Retry**, and a button to run the queue.
- `unready` with a database that is up means the shared schema version is not one this build
  supports: deploy the matching admin build, or finish the backend migration.
- A `site.notify` job that keeps failing does not hide or delay content (public reads are
  uncached); it only means the "Live" confirmation is missing. Check the backend receiver logs and
  that both sides share the same `BLOG_INVALIDATION_SECRET`.
