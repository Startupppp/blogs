# Content migration

Existing posts move to the revision model in place. Nothing is copied to another database,
nothing is deleted, and fixture content is never promoted.

## What migration 1703 does to existing rows

Migration `1703_blog_revisions_publication` in `streamlineos-backend` (the only migration owner):

1. Creates one **frozen** revision (`seq = 1`, `schema_version = 0`) per existing post from the row
   itself: `content_json` (or a `{"type":"legacyHtml"}` marker) as the document, `content` as the
   HTML, a tag-stripped copy as search text, and the title, slug, excerpt, SEO fields, cover URL
   (`legacy_cover_url`), author, category, tags and featured flag.
2. Points `working_revision_id` at it, and for `published` rows also `published_revision_id`.
   `published_at` keeps its value (falling back to `created_at`); `modified_at` takes
   `updated_at`. Archived rows get `archived_at`.
3. Gives every author a unique `slug` derived from the name (`-2`, `-3`… on collisions).

IDs, slugs, dates, taxonomy and image URLs are unchanged, and the legacy columns still hold what
was published, so the public site serves exactly the same articles after the migration as before.
The migration is re-runnable and has a rollback file
(`migrations/rollback/1703_blog_revisions_publication.down.sql`) that drops only what 1703 added.

## Converting a legacy article in the editor

A legacy revision (`schema_version = 0`) stays published as it is until someone republishes it.
To change it:

1. Open the post. The editor parses the stored HTML in the browser **into the editor's schema**:
   headings (h2–h4), paragraphs, lists, quotes, code, tables, links and inline formatting survive;
   anything the schema does not know (scripts, iframes, inline styles, unknown tags) is dropped.
2. The first save sends that structured document to the server, which validates it against the
   allowlist (`lib/content/document.ts`) and re-renders HTML and search text itself. Client HTML is
   never stored as trusted content.
3. **Images are not imported.** Legacy `<img>` tags carry no media id, so body images and the
   legacy cover must be uploaded again through the media library (which verifies, re-encodes and
   records credit and licence). Publishing is blocked until the post has a processed cover image
   with alt text.
4. Review the result in Preview, then publish. The old revision stays in History.

The check before publishing lists what still blocks the post (for example "This post was written
in the old editor. Open it in the editor and save once to convert it.").

## Rehearsal

Run the migration against a copy of the target database first:

```bash
createdb blog_rehearsal -T <copy-of-target>
psql -d blog_rehearsal -v ON_ERROR_STOP=1 -f migrations/1703_blog_revisions_publication.sql
psql -d blog_rehearsal -c "select count(*) filter (where working_revision_id is null) as missing_working,
  count(*) filter (where status = 'published' and published_revision_id is null) as missing_published
  from blog_posts"
```

Both counts must be 0. Then compare `GET /blog/posts` and a few `GET /blog/by-slug/:slug`
responses before and after; they should be identical apart from new fields.

What was rehearsed for this change is recorded in [verification.md](verification.md). It was not
run against the production database from this machine.
