# Verification and requirement matrix

Recorded 2026-09-30. Everything below ran on one developer machine against local PostgreSQL 17
databases and an in-memory S3 stand-in. **Nothing here was run against production, staging, real
Cloudflare R2 or a real Google OAuth client**; those checks are listed at the end as not verified.

## Commands and results

### This repository (`Startupppp/blogs`, `main`)

| Command | Result |
| --- | --- |
| `pnpm type-check` | exit 0 |
| `pnpm lint` | exit 0, no warnings |
| `pnpm test` | 4 files, 22 tests passed |
| `pnpm test:db` | 2 files, 18 tests passed (builds `blog_admin_test` from `db/test-schema/`, runs as the scoped `blog_admin_app` role) |
| `next build --webpack` (production) | exit 0; 20 routes, all dynamic except `/_not-found` and `/robots.txt` |
| `BACKEND_DIR=../streamlineos-backend-worktree pnpm check:schema-vendor` | `ok 1703_blog_revisions_publication.sql` |
| `next start` headers on `/preview/…`, `/posts` | `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`, `X-Robots-Tag: noindex, nofollow, noarchive`, CSP, HSTS |

### `streamlineos-backend`, branch `feat/blog-shared-publication`

| Command | Result |
| --- | --- |
| `tsc -p tsconfig.build.json` (12 GB heap) | exit 0 |
| `tsc -p tsconfig.test.json` | 64 errors, all in `src/modules/build/**` and `src/modules/cron/**` specs; none in files this branch changes |
| `jest src/modules/blog/__tests__/blog-public-reads.db.spec.ts` | 9 passed (local database) |
| `jest src/modules/blog/lib/blog-rss.spec.ts src/modules/blog/blog-invalidation.service.spec.ts` | 9 passed |
| `eslint src/modules/blog src/db/schema/blog` | clean |
| `generate-openapi.ts` | 4,100 operations; `/blog/admin/*`, `/blog/feed`, `/blog/by-slug/{slug}/adjacent` removed; 10 public/internal operations added |
| `check:openapi-coverage` | fails on 2 operations outside the blog module (`/hr/leave-policies/templates/dismiss`, `/kb/import-jobs/{id}/retry`), as on the base branch |
| `check:route-classification` | ALL ROUTES CLASSIFIED |
| `check:rate-limit-guards` | 1 new redundant mount in `modules/public/public.controller.ts` (not blog); 0 stale entries after pruning the 4 removed blog handlers |
| `check:migration-discipline` / `check:migration-rollback` | fail on migrations other than 1703 (13 missing rollbacks, none 1703) |
| 1703 on a scratch database | apply, re-apply (no-op), rollback, re-apply all succeed |
| 1703 on synthetic legacy rows (published / draft / archived, duplicate author names) | legacy columns byte-identical before and after (row md5 unchanged); every post has a working revision; only the published post is public; author slugs `ravi-kumar`, `ravi-kumar-2`; re-run adds no revisions |

### `streamlineos-frontend`, branch `feat/blog-shared-publication`

| Command | Result |
| --- | --- |
| `pnpm type-check` | exit 0 |
| `pnpm type-check:specs` | exit 0 |
| `jest lib/blog/blog-lib.test.ts` | 8 passed (sanitiser, contents anchors, canonical URLs, JSON-LD escaping, paging) |
| Related jest (blog, public fetch, proxy, sitemap) | 416 of 419 passed; the 3 failures (`infinite-cursor-falsy`, `record-surface-ratchet`) fail identically on the base commit |
| `check:seo-metadata`, `check:colors`, `check:dead-code`, import-direction for blog files | pass for every blog file; the gates' other failures predate this branch |
| `check:contract-parity` with the regenerated contract | fewer failures than with the old contract (required-field gaps 10 → 2, type mismatches 1 → 0); none involve blog operations |

## Cross-application run

Three separate processes against one database, `blog_e2e` (a copy of a local database at the
migration immediately before 1703, then 1703 applied):

- backend `dist/main.js` on :1600, as its own non-owner app role;
- frontend `next dev` on :3200 with `NEXT_PUBLIC_API_URL=http://localhost:1600`;
- admin `next dev` on :3100 as `blog_admin_app`, object store `pnpm dev:object-store` on :9000.

Sign-in used a session token minted with the admin's `AUTH_SECRET` for a seeded `blog_editors`
row, because no Google client exists yet (see the not-verified list).

| Step | Observed |
| --- | --- |
| Upload a cover through `upload-intent` → PUT → `finalize` | `ready`, 1800×1100, 9 variants (WebP + JPEG × 4 widths, 1200×630 social) |
| Create a post, write title, standfirst, body with two H2s, excerpt, cover + alt, author, category, tags | Autosaved; revision holds `paragraph, heading, paragraph, heading, paragraph` |
| Check before publishing | "Ready to publish" plus 3 advisory warnings (credit, SEO title, SEO description) |
| Publish now | `media.process` and `site.notify` jobs `done`; one receipt in `blog_invalidation_receipts`; panel shows **Live on StreamlineOS** |
| `GET localhost:3200/blogs` and the article | Post and cover render; `<meta name="streamline:revision">` equals the published revision; canonical, description, one `<h1>`, anchored H2s, 3 JSON-LD blocks; body text present in the server HTML |
| Change the URL in the draft | Public site still serves the old slug (200) and 404s the new one |
| Publish changes | Old slug → 308 to the new slug; new slug 200 with the new revision; RSS and sitemap list the new URL |
| Unpublish | Article 404; `/blog/posts` empty; RSS 0 items; sitemap has no entry |
| Restore as draft → Publish changes | Article 200 again; first `published_at` unchanged, `modified_at` advanced; audit trail `media.upload, post.create, post.publish, post.publish_rename, post.unpublish, post.restore, post.publish` |
| Preview as editor / anonymous | Editor: banner, noindex; anonymous: 307 to `/login` |
| Set `blog_schema_meta.version = 3` | Admin `/api/health` → 503 `unready` within the 60 s compatibility cache; back to 200 after reverting |
| Backend stopped | `/blogs`, article, archive, search, `/sitemap.xml`, `/blogs/rss.xml` all answer 500 with `noindex`; none answer an empty 200 or a 404 |
| Search "weekly review" / "zebra accounting" | 1 result / empty state with topic links |
| Widths 320, 375, 768, 1024, 1440 on home and article | `scrollWidth == innerWidth` at every width (no horizontal scroll) |
| CTA destinations `/pricing`, `/contact`, `/about` | 200 each |

### Defects the run found and fixed

| Defect | Fix |
| --- | --- |
| `trustHost: false` made Auth.js reject every request (`UntrustedHost`), so nobody could sign in | `c0890a9`: `trustHost: true`, `AUTH_URL` required and pinned to `ADMIN_ORIGIN` |
| Every heading, image, callout or table made the save fail ("expected object, received function"): ProseMirror attrs have a null prototype and React sent them as temporary references | `c49ab3e`: `structuredClone` the editor JSON; regression test |
| Post list 500'd once any post existed: `Intl.DateTimeFormat` rejects `dateStyle` + `timeZoneName` | `200b360`; regression test |
| Admin and app on one host overwrote each other's `authjs.session-token` | `8eae82d`: own cookie name |
| Hydration mismatch on locale-formatted times in the editor | `4e51758` |
| Preview called an unpublished revision "live" | `2f4da53` |
| Frontend CSP dropped an http media origin, so local images were blocked | frontend `ce45c9e9c` (development only; production stays https) |

### Screenshots

`docs/verification/`: `admin-published.jpg`, `admin-preview.jpg`, `public-home-desktop.jpg`,
`public-home-mobile.jpg`, `public-article-desktop.jpg`, `public-article-body-desktop.jpg`,
`public-article-mobile.jpg`, `public-search-desktop.jpg`, `public-search-empty-desktop.jpg`.
The cover is a generated abstract illustration made for this test; no third-party imagery is
shipped (media sourcing: none).

## Query plans at 10,000 posts

Rehearsal database with 10,003 posts (9,001 published), `EXPLAIN (ANALYZE, BUFFERS)`:

| Read | Plan | Time |
| --- | --- | --- |
| Listing page 1 | Index Scan `idx_blog_posts_public_order` | 0.04 ms |
| Category / tag listing page 1 | Index Scan `idx_blog_posts_public_order` + filter | 0.03 / 0.06 ms |
| Search, selective term | Bitmap Index Scan `idx_blog_posts_public_search` (GIN) | 0.16 ms |
| Search, common terms | Index Scan public order + filter | 0.35 ms |
| Listing page 750 (offset 8,988) | Seq Scan + sort | 7.5 ms |
| Published count | Seq Scan | 4.5 ms |

Deep pages and counts are sequential at this size; fine at 10k, and the sitemap already uses a
keyset cursor. Revisit listing offsets if the archive grows by an order of magnitude.

## Requirement matrix

Status: **Done** = implemented and verified as stated; **Local** = verified only against local
stand-ins; **Partial** = implemented with a stated gap; **Not verified** = no evidence yet.

### Public experience

| ID | Implementation | Evidence | Status |
| --- | --- | --- | --- |
| PUB-01 | Frontend `app/(public)/blogs/(site)/**`, `lib/blog/api.ts`; backend `blog.service.ts`, `blog-discovery.service.ts`; fixture route removed | Cross-app run | Done |
| PUB-02 | `publishedPostPredicate` on every read; request-scoped `cache()` so metadata and body share one read; `streamline:revision` meta | Backend DB spec; cross-app run | Done |
| PUB-03 | `ORDER BY published_at DESC, id DESC`; category/tag/author routes | "pages across equal timestamps" DB spec | Done |
| PUB-04 | `websearch_to_tsquery`, GIN index, `q` ≤ 200 chars, 2 s statement timeout, bounded results, rate limit | DB spec; plan above | Done |
| PUB-05 | Search empty and zero-result states with topic links | Screenshots | Done |
| PUB-06 | `/page/<n>` links; `/page/1` → 308; out of range → 404 | `blog-lib.test.ts` | Done |
| PUB-07 | Real 404; outage → 500 + noindex; deleted posts: 410 from the backend redirect resolver | Cross-app run | Partial: a Next page cannot answer 410, so a deleted post's URL answers 404 with the journal's "may have moved, been retired" page |
| PUB-08 | Public DTOs select explicit columns; no email, editor, revision or draft data | "never exposes the author's email" DB spec | Done |
| PUB-09 | Admin `readingTimeMinutes` (225 wpm, minimum 1) stored with the revision | Unit test | Done |
| PUB-10 | `lib/blog/cta.ts` keys → existing pages; placement in a data attribute, canonical unchanged | Destinations 200 | Done |

### Editorial CMS

| ID | Implementation | Evidence | Status |
| --- | --- | --- | --- |
| CMS-01 | Google OIDC via the admin's own client, host-only cookie, `blog_editors` access only | Cross-app run with a minted session | Local (no Google client yet) |
| CMS-02 | `/posts` with status filters, search, owner, author, updated time, preview | Cross-app run | Done |
| CMS-03 | Editor fields incl. social image, featured, CTA | Cross-app run | Done |
| CMS-04 | `lib/content/document.ts` allowlist; server renders HTML/text | Unit + DB tests ("refuses content outside the allowlist") | Done |
| CMS-05 | Autosave 1.5 s, status line, local backup + restore banner, `beforeunload` | Cross-app run (backup restore exercised) | Done |
| CMS-06 | `expectedVersion` on every write; 409 with server draft; conflict dialog | DB test "one of two editors … 409" | Done (dialog not exercised in a browser) |
| CMS-07 | `/preview/[postId]` with the same renderer, banner, noindex, no-store, editor auth | Cross-app run; production headers | Done |
| CMS-08 | `checkPublishable` field-level errors | DB test "blocks publishing with field-level reasons" | Done |
| CMS-09 | SEO lengths advisory; empty SEO falls back to title/excerpt | Cross-app run warnings | Done |
| CMS-10 | Draft edits change only the working revision | DB test; cross-app run | Done |
| CMS-11 | History, restore to new working revision, unpublish, schedule, cancel | DB tests (restore, schedule once, cancel) | Done |
| CMS-12 | `blog_audit_events` with actor, action, post, revision, safe summary | Cross-app audit trail | Done |
| CMS-13 | Authors/categories screens; archive instead of delete | Code review | Done (no dedicated test) |
| CMS-14 | Broken internal links, missing alt, processing state, missing credits; warnings vs errors | Cross-app run warnings | Done |

### Architecture, data, media, SEO, operations

| Section | Implementation | Evidence | Status |
| --- | --- | --- | --- |
| §6 Roles | `lib/server/auth/roles.ts`, checked in every action | DB test "a writer cannot edit another writer's draft or publish" | Done |
| §7 One migration owner, scoped role | Backend 1703; `db/provision-editorial-role.sql`; `compat.ts` | DB test "least privilege"; schema-version refusal | Done |
| §7 Durable jobs | `blog_jobs` leases, backoff, dead state; `/api/jobs/run` | DB tests; cross-app jobs `done` | Done (Vercel cron not registered) |
| §8 Lifecycle and predicate | `publish.ts` | DB tests; cross-app run | Done |
| §8 Slugs and redirects | `slug.ts`, redirects single-hop, 410 tombstones | Unit + DB tests; 308 observed | Done |
| §8 Legacy backfill | 1703 | Rehearsal above | Done (not run on production data) |
| §9 Media pipeline | `lib/server/media/**` | DB media tests (6); cross-app upload | Local (real R2 not verified) |
| §10 Metadata, JSON-LD, canonical | Frontend `lib/blog/seo.ts`, article JSON-LD | `blog-lib.test.ts`; cross-app HTML checks | Done |
| §10 Sitemap, RSS | Backend `sitemapPosts` (cursor), `rss.xml`; frontend `app/sitemap.ts`, rewrite | DB spec; cross-app run | Done |
| §11 Signed invalidation + live check | `jobs/notify.ts`, backend `blog-internal.controller.ts` | Unit (signature, rotation, replay) + DB tests + cross-app run | Done |
| §12 Security | Allowlist + sanitiser, Origin checks, DB rate limits, CSP, noindex | Unit tests; headers | Done |
| §13 Edge cases | Covered by the tests named above: concurrent saves, slug collision, reserved slugs, rename chains, draft edits, schedule twice/cancel, lying MIME, oversize, EXIF, no upscale, 410, duplicate headings, out-of-range pages | Tests | Done for those listed |
| §14 Performance | Plans above | 10k rehearsal | Partial: no Lighthouse, Core Web Vitals or p95 measurement |
| §15 Accessibility | Semantic markup, labels, focus styles | — | Not verified: no automated scan or keyboard walkthrough recorded |

## Not verified

- Real Cloudflare R2: presigned PUT signatures, bucket CORS, custom-domain TLS, cache headers.
- Real Google sign-in and first-login subject binding in a browser.
- Any deployment (admin, backend, frontend); staging canonical, redirect, sitemap and robots
  behaviour on a real origin; Vercel cron registration.
- Migration 1703 on the production or staging database.
- Lighthouse, Core Web Vitals, API p95, accessibility scan, keyboard walkthrough, JavaScript-off
  reading (article text is in the server HTML, but navigation was not tested without JS).
- The conflict dialog in a browser (the 409 path is covered by a DB test).
- Duplicate and out-of-order notifications over HTTP (covered at the service level only).
