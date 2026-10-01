# Verification and requirement matrix

Last re-run 1 October 2026, after merging `origin/main` into both existing-repository branches and
renumbering the shared migration to 1705. Everything below ran on one developer machine against
local PostgreSQL 17 databases and an in-memory S3 stand-in. **Nothing here was run against
production, staging, real Cloudflare R2 or a real Google OAuth client**; those checks are listed at
the end as not verified.

## Commands and results

### This repository (`Startupppp/blogs`, `main`)

| Command | Result |
| --- | --- |
| `pnpm type-check` | exit 0 |
| `pnpm lint` | exit 0, no warnings |
| `pnpm test` | 4 files, 22 tests passed |
| `pnpm test:db` | 3 files, 25 tests passed (builds `blog_admin_test` from `db/test-schema/`, runs as the scoped `blog_admin_app` role) |
| `next build` (production) | exit 0; 20 routes, all dynamic except `/_not-found` and `/robots.txt` |
| `BACKEND_DIR=… pnpm check:schema-vendor` | `ok 1705_blog_revisions_publication.sql`, then 6 tables / 68 columns compared against the backend's Drizzle schema; proven to fail when a column is added upstream |
| Client bundle grep for every secret in `.env.example` | 0 hits in `.next/static` |
| `next start` headers on `/preview/…`, `/posts`, `/robots.txt` | `Cache-Control: private, no-store…`, `X-Robots-Tag: noindex, nofollow, noarchive`, CSP, HSTS, `Disallow: /` |

### `streamlineos-backend`, branch `feat/blog-shared-publication`

| Command | Result |
| --- | --- |
| `tsc -p tsconfig.build.json` (12 GB heap) | exit 0. It was **2 errors before this branch**: `origin/main` calls `bulkInvite` with a `moduleAccess` argument its signature never declared. Fixed here. |
| `pnpm build` (nest) | exit 0 |
| `jest src/modules/blog` | 12 passed (RSS, invalidation signature, the new guard) |
| `jest blog-public-reads.db.spec.ts` | 9 passed against a local database |
| `eslint src/modules/blog src/db/schema/blog` | clean |
| `openapi:generate` | 4,102 operations; no `/blog/admin/*` remains; 12 public/internal blog operations |
| `check:route-classification` | ALL ROUTES CLASSIFIED |
| Migration 1705 on a scratch database | apply, re-apply (no-op), rollback, re-apply all succeed |
| `migrations/meta/_journal.json` | no duplicate `idx`; the blog entry is 1160, after `origin/main`'s 1704 |

### `streamlineos-frontend`, branch `feat/blog-shared-publication`

| Command | Result |
| --- | --- |
| `pnpm type-check` | exit 0 |
| `jest features/blog lib/blog` | 14 passed (sanitiser, contents anchors, canonical URLs, JSON-LD escaping, paging, mobile-menu keyboard behaviour) |
| `eslint features/blog lib/blog app/(public)/blogs` | 0 errors, 3 `no-img-element` warnings (deliberate: the cover builds its own `srcset` from R2) |
| `check:seo-metadata` | OK, 1,339 route files scanned |
| `pnpm type-check:specs` | 17 errors, **none in blog files**: all in calendar, chat, mail and expenses specs that arrived with `origin/main` |
| `check:contract-parity` | **fails** — see "Handed back" below |

## Cross-application run

Three separate processes against one database, `blog_e2e`:

- backend `dist/main.js` on :1600, as its own non-owner app role;
- frontend `next dev` on :3200 with `NEXT_PUBLIC_API_URL=http://localhost:1600`;
- admin `next dev` on :3100 as `blog_admin_app`, object store `pnpm dev:object-store` on :9000.

Sign-in used a session token minted with the admin's `AUTH_SECRET` for a seeded `blog_editors`
row, because no Google client exists yet (see the not-verified list). Everything else was driven
through the admin's own UI in a browser.

| Step | Observed |
| --- | --- |
| Upload a cover through `upload-intent` → PUT → `finalize` → job | `ready`, 800×600, 5 variants (WebP + JPEG, no upscaling past the source width, plus the 1200×630 social crop) |
| Create a post; type title, standfirst, body with H2s, excerpt, cover + alt, author, category | Autosaved on idle; "Saved hh:mm:ss"; slug derived from the title |
| Check before publishing | "Ready to publish" plus 3 advisory warnings (image credit, SEO title, SEO description) — warnings do not block |
| Publish now | Panel shows **Published** and **Live on StreamlineOS · View article**; `site.notify` job `done`; receipt recorded by the backend |
| `GET :3200/blogs/<slug>` | 200; body text in the server HTML; one `<h1>`; 3 anchored H2s; 6 JSON-LD blocks; canonical `https://www.streamlineos.in/...` (from configuration, not the request host); `<meta name="streamline:revision">` equal to `published_revision_id`; cover as `<picture>` with WebP `srcSet`, JPEG fallback, intrinsic width/height, content-addressed keys |
| Listing, RSS, sitemap | each lists the new article |
| Edit the draft (change the standfirst) | Public page unchanged; a second revision exists; `published_revision_id ≠ working_revision_id` |
| Change the URL, then publish changes | Old slug → **308** to the new slug; new slug 200 serving the edited text; redirect row + `post.publish_rename` audit entry; RSS carries the new URL |
| Unpublish (native confirm first) | Article **404**; gone from the homepage, archive, search, RSS and sitemap; `post.unpublish` audited; the notify job only completes after the admin itself confirms the public 404 |
| Concurrent edit (another writer bumps `version`) | Autosave refuses: "Not saved — someone else changed this post" and a conflict dialog with YOUR VERSION / THEIR VERSION side by side and *Discard mine and load theirs* / *Keep mine (replaces theirs)* |
| Preview and `/posts` as an anonymous visitor | 307 to `/login` |
| `/api/media/upload-intent` without an Origin / with Origin and no session | 403 / 401 |
| `/api/jobs/run` with no bearer and with a wrong bearer | 401 / 401 |
| Signed invalidation: valid, replayed, tampered body, 10,000 s skew | 200 `duplicate:false` / 200 `duplicate:true` / 401 / 401 |
| `GET /blog/admin/posts` on the backend | 404 — the old NestJS admin write API is gone |

### Accessibility

axe-core 4.13 (`wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`) on the running site:

| Page | Violations |
| --- | --- |
| Homepage (desktop and 375) | 0 |
| Article (desktop and 320) | 0 |
| Archive, category, author, search, empty search, editorial policy | 0 |

One **serious** violation was found and fixed during this run: `link-in-text-block` — the byline
author link was distinguished from the muted text around it by colour alone.

No horizontal overflow (`scrollWidth == innerWidth`) at 320, 375, 768 and 1440. The mobile menu's
keyboard behaviour (Escape closes and returns focus, Tab cycles inside the open menu, links work
without JavaScript) is covered by `features/blog/mobile-nav.test.tsx`.

### Defects this verification found

| Defect | Fix |
| --- | --- |
| Every author and category showed **0 live posts** on the management screens: Drizzle interpolates a column reference into a `sql` template unqualified, so the correlated subquery read `p.author_id = "id"` and bound to `blog_posts.id`. The archive guard used a separate query and was correct. | `96a9f7f`, plus the taxonomy database tests the requirement never had |
| `link-in-text-block` (WCAG 1.4.1) on four page types | frontend `aaf13ed31` |
| The invalidation HMAC was checked *after* `@Validate`, so an unsigned caller received field-level validation detail | backend `3798d56f7`: a guard, which runs before pipes |
| `origin/main` and this branch both shipped a migration numbered 1703, at the same journal index | backend `42e1bd542`: renumbered to 1705 / idx 1160 |
| `origin/main` does not compile (2 TS errors in the invitation path) | backend `86045d23e` |
| `0000_blog_legacy.sql` was excluded from drift checking, so the database tests could pass against a schema the backend no longer creates | `44fe767`: column-by-column comparison against the backend's Drizzle schema |

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
| PUB-02 | `publishedPostPredicate` on every read; request-scoped `cache()`; `streamline:revision` meta | Backend DB spec; cross-app run | Done |
| PUB-03 | `ORDER BY published_at DESC, id DESC`; category/tag/author routes | "pages across equal timestamps" DB spec | Done |
| PUB-04 | `websearch_to_tsquery`, GIN index, `q` ≤ 200 chars, 2 s statement timeout, bounded results, rate limit | DB spec; plan above | Done |
| PUB-05 | Search empty and zero-result states with topic links | Cross-app run | Done |
| PUB-06 | `/page/<n>` links; `/page/1` → 308; out of range → 404 | `blog-lib.test.ts` | Done |
| PUB-07 | Real 404; outage → 500 + noindex; deleted posts: 410 from the backend redirect resolver | Cross-app run | Partial: an App Router page cannot answer 410, so a deleted post's URL answers 404 with the journal's retired-story page, explicitly `noindex` |
| PUB-08 | Public DTOs select explicit columns; no email, editor, revision or draft data | DB spec; live article JSON | Done |
| PUB-09 | Admin `readingTimeMinutes` (225 wpm, minimum 1) stored with the revision | Unit test | Done |
| PUB-10 | `lib/blog/cta.ts` keys → existing pages; placement in a data attribute, canonical unchanged | Destinations 200 | Done |

### Editorial CMS

| ID | Implementation | Evidence | Status |
| --- | --- | --- | --- |
| CMS-01 | Google OIDC via the admin's own client, host-only cookie, `blog_editors` access only | Cross-app run with a minted session; anonymous 307 | Local (no Google client yet) |
| CMS-02 | `/posts` with status filters, search, owner, author, updated time, preview | Cross-app run | Done |
| CMS-03 | Editor fields incl. social image, featured, CTA | Cross-app run | Done |
| CMS-04 | `lib/content/document.ts` allowlist; server renders HTML/text | Unit + DB tests | Done |
| CMS-05 | Autosave 1.5 s, status line, local backup + restore banner, `beforeunload` | Cross-app run | Done |
| CMS-06 | `expectedVersion` on every write; 409 with the server draft; conflict dialog | DB test **and** the dialog exercised in a browser | Done |
| CMS-07 | `/preview/[postId]` with the same renderer, banner, noindex, no-store, editor auth | Cross-app run; production headers | Done |
| CMS-08 | `checkPublishable` field-level errors | DB test; publish stays disabled until the check passes | Done |
| CMS-09 | SEO lengths advisory; empty SEO falls back to title/excerpt | Cross-app run warnings | Done |
| CMS-10 | Draft edits change only the working revision | DB test; cross-app run (public page unchanged) | Done |
| CMS-11 | History, restore to a new working revision, unpublish, schedule, cancel | DB tests; unpublish and restore in the browser | Done |
| CMS-12 | `blog_audit_events` with actor, action, post, revision, safe summary | Cross-app audit trail | Done |
| CMS-13 | Authors/categories screens; archive instead of delete | `tests/db/taxonomy.test.ts` (7 tests) | Done |
| CMS-14 | Broken internal links, missing alt, processing state, missing credits; warnings vs errors | Cross-app run warnings | Done |

### Architecture, data, media, SEO, operations

| Section | Implementation | Evidence | Status |
| --- | --- | --- | --- |
| §6 Roles | `lib/server/auth/roles.ts`, checked in every action | DB tests (a writer refused for taxonomy and for another writer's draft) | Done |
| §7 One migration owner, scoped role | Backend 1705; `db/provision-editorial-role.sql`; `compat.ts` | DB test "least privilege"; schema-version refusal | Done |
| §7 Durable jobs | `blog_jobs` leases, backoff, dead state; `/api/jobs/run` | DB tests; cross-app jobs `done` | Done (hosting cron not registered) |
| §8 Lifecycle and predicate | `publish.ts` | DB tests; cross-app run | Done |
| §8 Slugs and redirects | `slug.ts`, redirects single-hop, 410 tombstones | Unit + DB tests; 308 observed | Done |
| §8 Legacy backfill | 1705 | Rehearsal | Done (not run on production data) |
| §9 Media pipeline | `lib/server/media/**` | DB media tests; cross-app upload and publish | Local (real R2 not verified) |
| §10 Metadata, JSON-LD, canonical | Frontend `lib/blog/seo.ts`, article JSON-LD | `blog-lib.test.ts`; cross-app HTML checks | Done |
| §10 Sitemap, RSS | Backend `sitemapPosts` (cursor), `rss.xml`; frontend `app/sitemap.ts`, rewrite | DB spec; cross-app run | Done |
| §11 Signed invalidation + live check | `jobs/notify.ts`, backend `blog-internal.controller.ts` + signature guard | Unit tests + live valid/replay/tamper/skew probes | Done |
| §12 Security | Allowlist + sanitiser, Origin checks, DB rate limits, CSP, noindex, no secrets in the client bundle | Unit tests; live probes | Done |
| §13 Edge cases | Concurrent saves, slug collision, reserved slugs, rename chains, draft edits, schedule twice/cancel, lying MIME, oversize, EXIF, no upscale, 410, duplicate headings, out-of-range pages | Tests + cross-app run | Done for those listed |
| §14 Performance | Plans above | 10k rehearsal | Partial: no Lighthouse, Core Web Vitals or p95 measurement |
| §15 Accessibility | Semantic markup, labels, focus styles, `<details>` menu | axe-core on 8 page types at 3 widths, 0 violations | Done (automated; no screen-reader pass) |

## Not verified

- Real Cloudflare R2: presigned PUT signatures, bucket CORS, custom-domain TLS, cache headers.
- Real Google sign-in and first-login subject binding in a browser.
- Any deployment (admin, backend, frontend); staging canonical, redirect, sitemap and robots
  behaviour on a real origin; the hosting scheduler's cron registration.
- Migration 1705 on the production or staging database.
- Lighthouse, Core Web Vitals, API p95.
- A manual screen-reader pass (axe is automated coverage, not a substitute).
- Duplicate and out-of-order notifications over HTTP (covered at the service level and by the
  live replay probe, but not with two concurrent dispatchers).

## Handed back

`check:contract-parity` on the frontend fails after the contract was regenerated from the merged
backend. The regenerated document both resolves 18 frozen baseline entries and surfaces 6 new
findings (`version` on three build/QA operations, `ownerSelfApproval` on two HR operations, a
nullable `sender.id` on `GET /chat/saved`) plus 21 `POST /clients` columns. **None of them are blog
operations**: they are other lanes' contract debt, which `origin/main`'s stale vendored copy was
hiding. Resolving it means either fixing those six contracts or recording them in the gate's frozen
baseline, which is a deliberate policy decision for whoever owns those lanes.
