# Architecture

The blog admin is a standalone Next.js (App Router, Node runtime) application. It is the only
writer of blog content. Streamline OS stays the only public destination: its existing backend
reads the same tables and its existing frontend renders `/blogs`.

```text
Editor ──► blog admin (this repo, Next.js)
             │  Server Actions / Route Handlers / server-only services
             ├─► shared Postgres: blog_* tables only, via the scoped blog_admin_app role
             ├─► R2 private bucket (originals, draft renditions)  ─┐ promote on publish
             ├─► R2 public bucket  (published renditions only)  ◄──┘
             └─► POST {backend}/blog/internal/invalidate  (HMAC-signed, from the job runner)

Reader ──► streamlineos-frontend /blogs (dynamic SSR, no-store fetches)
             └─► streamlineos-backend GET /blog/*  ─► same Postgres, published projection only
             └─► public media domain (R2 public bucket)
```

There is no separate NestJS or Express service for the admin. The backend endpoint above is a
public-site integration receiver, not an admin write API; the old `/blog/admin/*` API was removed.

## Repositories and ownership

| Repository | Owns |
| --- | --- |
| `streamlineos-blog-admin` (this) | Editorial UI, auth, validation, Drizzle writes, revisions, publishing, scheduling, R2 upload/processing/promotion, durable jobs |
| `streamlineos-backend` | The **only** migration history (migration `1703_blog_revisions_publication`), public read endpoints, the publication predicate, sitemap/RSS/search/redirect reads, the signed invalidation receiver |
| `streamlineos-frontend` | `/blogs` pages, SEO metadata, JSON-LD, sitemap integration, RSS proxy, journal design |

The admin never runs migrations. It declares the shared-schema versions it can write
(`lib/server/db/compat.ts`, `SUPPORTED_SCHEMA_VERSIONS = [2]`) and checks `blog_schema_meta.version`
before every write and in `/api/health`; any other version answers 503 and writes nothing.
`db/test-schema/` holds byte-identical copies of the backend migrations its database tests need;
`pnpm check:schema-vendor` fails if they drift.

## Data model (after migration 1703)

- `blog_posts` keeps every legacy column. Those columns now hold the **published projection** of
  `published_revision_id`, so any reader that only knows the old columns keeps serving exactly what
  was last published. New columns: `working_revision_id`, `published_revision_id`,
  `scheduled_revision_id`, `scheduled_for`, `schedule_version`, `version`, `modified_at`,
  `archived_at`, `deleted_at`, `standfirst`, `search_text`, `cover` (jsonb projection),
  `social_image`, `cta_key`, `owner_editor_id`.
- `blog_post_revisions`: one row per revision (structured document, derived HTML and text, all
  editorial fields). The working revision is mutable until publish, schedule or a named checkpoint
  freezes it; the next edit then starts a new revision.
- `blog_editors`: explicit editorial access (writer / publisher / admin), bound to a Google subject.
- `blog_media`, `blog_revision_media`: media records and the revision → media references used for
  safe cleanup.
- `blog_redirects`: single-hop redirects (slug changes create them; chains are collapsed; loops
  and external targets are rejected), plus 410 tombstones for deleted posts.
- `blog_jobs`: durable outbox (leases, `SKIP LOCKED`, exponential backoff 15 s → 30 min, dead state).
- `blog_audit_events`, `blog_rate_limits`, `blog_invalidation_receipts`, `blog_schema_meta`.

### Publication predicate

Every public read, count, search, related list, author page, feed and sitemap uses one predicate
(`streamlineos-backend/src/modules/blog/blog-public.projection.ts`):

```sql
status = 'published' AND published_revision_id IS NOT NULL
AND archived_at IS NULL AND deleted_at IS NULL
AND published_at <= (now() AT TIME ZONE 'UTC')
```

## Lifecycle

| Action | Where | Effect |
| --- | --- | --- |
| Save draft | `lib/server/blog/posts.ts` `saveDraft` | Expected-version check (409 with the server draft on conflict), row lock, server-side document validation, HTML/text derived on the server |
| Publish | `lib/server/blog/publish.ts` `publishNow` | One transaction: lock, validate the revision and its media, promote media, write the projection, set first `published_at` once, bump the generation, enqueue `site.notify` |
| Schedule / cancel | `schedulePost` / `cancelSchedule` | Stores the exact revision and UTC instant with `schedule_version`; a stale job sees the version change and does nothing |
| Unpublish | `unpublishPost` | Status `archived`; the predicate hides it immediately at the origin; notify queued; revisions kept |
| Restore | `restoreArchived` | Back to draft; stays off the site until published again; first publication date kept |
| Delete | `deletePost` | Soft delete; a post that was public leaves a 410 tombstone so its URL is never reused |

## Cross-app consistency

Public pages render dynamically with `no-store` fetches and the backend's blog reads are uncached,
so a committed publish, update or withdrawal is visible on the next request even if notification
fails. The notification exists to confirm visibility:

1. The job runner POSTs `{eventId, postId, generation, reason, revisionId, slug}` to the backend,
   signed `v1=` HMAC-SHA256 over `${timestamp}.${eventId}.${rawBody}` (300 s window; a previous
   secret is accepted during rotation). Retries reuse the event id with a fresh signature.
2. The backend records the receipt (deduplicated by event id) and answers with the post's current
   published revision.
3. The runner then fetches the public article and checks `<meta name="streamline:revision">`
   matches. Only then does the editor see **Live on StreamlineOS**; otherwise the job retries and the
   Operations page shows it.

A superseded event (a newer generation for the same post) is completed without sending.

## Authentication and authorization

- Google OIDC through this admin's own client (`/api/auth/callback/google`), JWT session in a
  host-only cookie named `blog-admin.session-token` (`__Secure-` prefixed on https), 8 h lifetime.
- No sign-up: sign-in succeeds only for a verified Google account whose email has an enabled
  `blog_editors` row; the first sign-in binds the Google subject to that row.
- Every Server Action and Route Handler re-loads the editor from the database and checks the
  capability (`lib/server/auth/roles.ts`). Writers edit only drafts assigned to them.
- Server Actions get Next's Origin/Host check; Route Handlers call `assertSameOrigin`.
- Customer-organisation roles in Streamline OS never grant editorial access.

| Capability | Writer | Publisher | Admin |
| --- | --- | --- | --- |
| Create and edit assigned drafts, preview, upload media | ✓ | ✓ | ✓ |
| Edit any post, publish, schedule, unpublish, reassign, manage media and redirects | | ✓ | ✓ |
| Manage authors and categories | | `PUBLISHERS_MANAGE_TAXONOMY` | ✓ |
| Manage editorial access | | | ✓ |

## Media

1. `POST /api/media/upload-intent` → a 5-minute presigned PUT for one random key under
   `pending/` in the private bucket (JPEG, PNG, WebP; ≤ 10 MiB declared).
2. The browser PUTs directly to R2, then `POST /api/media/finalize` with the media id.
3. Finalize re-reads the bytes, sniffs the real type, decodes, rejects animation and > 40 MP,
   and copies exactly those bytes to an immutable key named by their SHA-256.
4. `media.process` strips metadata, auto-orients and writes WebP + JPEG at 480/768/1200/1600 px
   (never upscaled) plus a 1200×630 social crop at the focal point.
5. Drafts show images through `/api/media/[id]/file`, which checks the editor's access.
6. Publishing copies only the variants the published revision references to the public bucket
   under `blog/<mediaId>/<sha>.<ext>`, served by `MEDIA_PUBLIC_ORIGIN` with a one-year immutable
   cache.
7. Cleanup (`sweepMedia`, every job-runner tick) removes abandoned uploads after a day,
   unreferenced failed media after a week, and withdraws public copies no revision references
   after a day.

## Jobs

`/api/jobs/run` (bearer `CRON_SECRET`, GET or POST) claims a bounded batch with a lease and runs
`media.process`, `post.publish_scheduled` and `site.notify` jobs, then the media sweep and
rate-limit pruning. Vercel Cron calls it every minute (`vercel.json`). Publish, finalize and unpublish also run their own job inline within a time
budget so the editor usually sees the result without waiting for the next tick.
