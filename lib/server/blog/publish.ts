import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { parseDocument } from "@/lib/content/document";
import { audit } from "../audit";
import { assertCan, type Editor } from "../auth/editor";
import type { Db, Tx } from "../db/client";
import { blogPostRevisions, blogPosts, blogRedirects, blogSchemaMeta } from "../db/schema";
import { env } from "../env";
import { ServiceError, notFound } from "../errors";
import { enqueue } from "../jobs/queue";
import { promoteMedia } from "../media/promote";
import { coverProjection, publicUrlFor, socialVariant } from "../media/urls";
import { checkPublishable } from "./publish-checks";
import { assertVersion, collectMediaIds, loadMedia, lockPost, renderRevisionDoc, type PostRow, type RevisionRow } from "./posts";

export type NotifyReason = "publish" | "update" | "rename" | "unpublish" | "delete";

export interface NotifyPayload {
  eventId: string;
  postId: string;
  generation: number;
  reason: NotifyReason;
  /** The revision the public site must now serve, or null when the post must be gone. */
  revisionId: string | null;
  slug: string;
}

const SCHEDULE_MIN_LEAD_MS = 60_000;
const SCHEDULE_MAX_LEAD_MS = 366 * 24 * 60 * 60 * 1000;

async function loadRevision(database: Db | Tx, postId: string, revisionId: string | null): Promise<RevisionRow> {
  if (!revisionId) throw notFound("Revision");
  const [rev] = await database.select().from(blogPostRevisions)
    .where(and(eq(blogPostRevisions.id, revisionId), eq(blogPostRevisions.postId, postId)));
  if (!rev) throw notFound("Revision");
  return rev;
}

function blockIfInvalid(check: Awaited<ReturnType<typeof checkPublishable>>) {
  if (Object.keys(check.errors).length) {
    throw new ServiceError(422, "not_publishable", "Fix the highlighted fields before publishing.", check.errors, { warnings: check.warnings });
  }
}

/** Advances the shared publication generation. Every publish, rename and withdrawal bumps it. */
async function bumpGeneration(tx: Tx): Promise<number> {
  const [row] = await tx.update(blogSchemaMeta)
    .set({ publicationGeneration: sql`${blogSchemaMeta.publicationGeneration} + 1`, updatedAt: new Date() })
    .where(eq(blogSchemaMeta.id, 1))
    .returning({ generation: blogSchemaMeta.publicationGeneration });
  if (!row) throw new ServiceError(503, "schema_meta_missing", "The shared blog schema is not initialised.");
  return row.generation;
}

async function queueNotify(tx: Tx, payload: Omit<NotifyPayload, "eventId">): Promise<string> {
  const eventId = crypto.randomUUID();
  const dedupeKey = `notify:${payload.postId}:${payload.generation}`;
  await enqueue(tx, "site.notify", { ...payload, eventId }, { dedupeKey, maxAttempts: 10 });
  return dedupeKey;
}

/**
 * Writes the published projection from one frozen revision, inside the caller's transaction and
 * under the caller's row lock. Body HTML, cover, social image and metadata all come from `rev`, so
 * the public page and its metadata can never describe two different revisions.
 */
async function applyPublication(tx: Tx, post: PostRow, rev: RevisionRow, actorId: string | null): Promise<{ generation: number; notifyKey: string }> {
  const parsed = parseDocument(rev.doc);
  if (!parsed.success) throw new ServiceError(422, "not_publishable", "The article body cannot be published.", { doc: "Invalid content" });
  const bodyMedia = await loadMedia(tx, [
    ...new Set([...collectMediaIds(parsed.data), rev.coverMediaId, rev.socialMediaId].filter((x): x is string => Boolean(x))),
  ]);
  for (const m of bodyMedia.values()) {
    if (m.status !== "ready" || !m.promotedAt) throw new ServiceError(409, "media_not_promoted", "An image changed while publishing. Try again.");
  }

  const urlFor = publicUrlFor(env().MEDIA_PUBLIC_ORIGIN);
  const rendered = renderRevisionDoc(parsed.data, bodyMedia);
  const coverMedia = rev.coverMediaId ? bodyMedia.get(rev.coverMediaId) : undefined;
  const cover = coverMedia
    ? coverProjection(coverMedia.variants, urlFor, { alt: rev.coverAlt ?? "", caption: rev.coverCaption, credit: coverMedia.credit })
    : null;
  if (!cover) throw new ServiceError(422, "not_publishable", "Add a cover image.", { coverMediaId: "Add a cover image." });
  const socialSource = (rev.socialMediaId ? bodyMedia.get(rev.socialMediaId) : undefined) ?? coverMedia;
  const social = socialSource ? socialVariant(socialSource.variants) : null;

  const previousSlug = post.publishedRevisionId && post.status === "published" ? post.slug : null;
  const renamed = Boolean(post.publishedRevisionId) && post.slug !== rev.slug;
  const reason: NotifyReason = !post.publishedRevisionId || post.status !== "published" ? "publish" : renamed ? "rename" : "update";

  await tx.update(blogPostRevisions)
    .set({ frozenAt: rev.frozenAt ?? new Date(), html: rendered.html })
    .where(eq(blogPostRevisions.id, rev.id));

  await tx.update(blogPosts).set({
    title: rev.title,
    slug: rev.slug,
    excerpt: rev.excerpt,
    standfirst: rev.standfirst,
    content: rendered.html,
    contentJson: parsed.data,
    searchText: rendered.text.slice(0, 200_000),
    readingTime: rev.readingTime,
    coverImage: cover.src,
    cover,
    socialImage: social ? urlFor(social) : null,
    categoryId: rev.categoryId,
    authorId: rev.authorId,
    tags: rev.tags,
    isFeatured: rev.isFeatured,
    metaTitle: rev.seoTitle,
    metaDescription: rev.seoDescription,
    ctaKey: rev.ctaKey,
    status: "published",
    publishedRevisionId: rev.id,
    workingRevisionId: post.workingRevisionId === post.scheduledRevisionId || post.workingRevisionId === rev.id ? rev.id : post.workingRevisionId,
    // First publication time is set once and never reset; UTC clock time, millisecond precision.
    publishedAt: sql`coalesce(${blogPosts.publishedAt}, date_trunc('milliseconds', now() AT TIME ZONE 'UTC'))`,
    modifiedAt: new Date(),
    archivedAt: null,
    scheduledRevisionId: null,
    scheduledFor: null,
    scheduleVersion: post.scheduleVersion + (post.scheduledRevisionId ? 1 : 0),
    version: post.version + 1,
    updatedAt: new Date(),
  }).where(eq(blogPosts.id, post.id));

  // The post may reclaim one of its own old URLs; nobody else's.
  await tx.delete(blogRedirects).where(and(eq(blogRedirects.sourcePath, `/blogs/${rev.slug}`), eq(blogRedirects.postId, post.id)));
  if (renamed && previousSlug) {
    const from = `/blogs/${previousSlug}`;
    const to = `/blogs/${rev.slug}`;
    // Collapse chains: every older URL of this post now points straight at the newest one.
    await tx.update(blogRedirects).set({ targetPath: to, updatedAt: new Date() })
      .where(and(eq(blogRedirects.postId, post.id), eq(blogRedirects.statusCode, 301)));
    await tx.insert(blogRedirects).values({ sourcePath: from, targetPath: to, statusCode: 301, postId: post.id })
      .onConflictDoUpdate({
        target: blogRedirects.sourcePath,
        set: { targetPath: to, statusCode: 301, updatedAt: new Date() },
        setWhere: eq(blogRedirects.postId, post.id),
      });
  }

  const generation = await bumpGeneration(tx);
  const notifyKey = await queueNotify(tx, { postId: post.id, generation, reason, revisionId: rev.id, slug: rev.slug });
  await audit(tx, {
    actorId,
    action: reason === "publish" ? "post.publish" : reason === "rename" ? "post.publish_rename" : "post.publish_update",
    postId: post.id,
    revisionId: rev.id,
    summary: renamed ? `URL changed from /blogs/${previousSlug} to /blogs/${rev.slug}` : `revision ${rev.seq}`,
  });
  return { generation, notifyKey };
}

export interface PublishOutcome {
  version: number;
  notifyKey: string;
  publicUrl: string;
  warnings: string[];
}

/** Publishes the current working revision now. */
export async function publishNow(database: Db, editor: Editor, postId: string, expectedVersion: number): Promise<PublishOutcome> {
  assertCan(editor, "post:publish");
  const [snapshot] = await database.select().from(blogPosts).where(eq(blogPosts.id, postId));
  if (!snapshot || snapshot.deletedAt) throw notFound("Post");
  if (snapshot.version !== expectedVersion) {
    throw new ServiceError(409, "version_conflict", "This post was changed by someone else since you opened it.");
  }
  const rev = await loadRevision(database, postId, snapshot.workingRevisionId);
  const check = await checkPublishable(database, snapshot, rev);
  blockIfInvalid(check);
  // Copies verified image variants to public delivery BEFORE the post becomes eligible. If the
  // transaction below fails, the copies are orphans that media cleanup removes after a grace period.
  await promoteMedia(database, check.mediaIds);

  const result = await withSlugConflict(() => database.transaction(async (tx) => {
    const post = await lockPost(tx, postId);
    await assertVersion(tx, post, expectedVersion);
    if (post.workingRevisionId !== rev.id) throw new ServiceError(409, "version_conflict", "The draft changed while publishing. Review and publish again.");
    const recheck = await checkPublishable(tx, post, rev);
    blockIfInvalid(recheck);
    const applied = await applyPublication(tx, post, rev, editor.id);
    return { ...applied, version: post.version + 1 };
  }));
  return { version: result.version, notifyKey: result.notifyKey, publicUrl: `${env().PUBLIC_SITE_ORIGIN}/blogs/${rev.slug}`, warnings: check.warnings };
}

async function withSlugConflict<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
    if (code === "23505") throw new ServiceError(409, "slug_taken", "Another post took this URL a moment ago.", { slug: "Another post already uses this URL." });
    throw error;
  }
}

/**
 * Schedules the current working revision for a UTC instant. The revision is frozen, so later edits
 * start a new working revision and never change what was scheduled. A time in the past is refused
 * with `schedule_in_past` so the editor chooses "publish now" explicitly.
 */
export async function schedulePost(database: Db, editor: Editor, postId: string, expectedVersion: number, whenIso: string) {
  assertCan(editor, "post:publish");
  const when = new Date(whenIso);
  if (Number.isNaN(when.getTime())) throw new ServiceError(400, "invalid_time", "Choose a valid date and time.", { scheduledFor: "Choose a valid date and time." });
  const lead = when.getTime() - Date.now();
  if (lead < SCHEDULE_MIN_LEAD_MS) {
    throw new ServiceError(422, "schedule_in_past", "That time has already passed. Publish now instead?", { scheduledFor: "Choose a time at least one minute from now." }, { canPublishNow: true });
  }
  if (lead > SCHEDULE_MAX_LEAD_MS) throw new ServiceError(422, "schedule_too_far", "Schedule within the next year.", { scheduledFor: "Schedule within the next year." });

  const [snapshot] = await database.select().from(blogPosts).where(eq(blogPosts.id, postId));
  if (!snapshot || snapshot.deletedAt) throw notFound("Post");
  const rev = await loadRevision(database, postId, snapshot.workingRevisionId);
  blockIfInvalid(await checkPublishable(database, snapshot, rev));

  return database.transaction(async (tx) => {
    const post = await lockPost(tx, postId);
    await assertVersion(tx, post, expectedVersion);
    if (post.workingRevisionId !== rev.id) throw new ServiceError(409, "version_conflict", "The draft changed while scheduling. Review and schedule again.");
    const scheduleVersion = post.scheduleVersion + 1;
    await tx.update(blogPostRevisions)
      .set({ frozenAt: rev.frozenAt ?? new Date(), changeSummary: rev.changeSummary ?? "Scheduled" })
      .where(eq(blogPostRevisions.id, rev.id));
    await tx.update(blogPosts)
      .set({ scheduledRevisionId: rev.id, scheduledFor: when, scheduleVersion, version: post.version + 1, updatedAt: new Date() })
      .where(eq(blogPosts.id, postId));
    await enqueue(tx, "post.publish_scheduled", { postId, revisionId: rev.id, scheduleVersion }, {
      runAfter: when,
      dedupeKey: `schedule:${postId}:${scheduleVersion}`,
      maxAttempts: 12,
    });
    await audit(tx, { actorId: editor.id, action: "post.schedule", postId, revisionId: rev.id, summary: `for ${when.toISOString()}` });
    return { version: post.version + 1, scheduledFor: when.toISOString() };
  });
}

/** Cancels a schedule. Bumping schedule_version turns any already-queued job into a no-op. */
export async function cancelSchedule(database: Db, editor: Editor, postId: string, expectedVersion: number) {
  assertCan(editor, "post:publish");
  return database.transaction(async (tx) => {
    const post = await lockPost(tx, postId);
    await assertVersion(tx, post, expectedVersion);
    if (!post.scheduledRevisionId) throw new ServiceError(409, "not_scheduled", "This post is not scheduled.");
    await tx.update(blogPosts)
      .set({ scheduledRevisionId: null, scheduledFor: null, scheduleVersion: post.scheduleVersion + 1, version: post.version + 1, updatedAt: new Date() })
      .where(eq(blogPosts.id, postId));
    await audit(tx, { actorId: editor.id, action: "post.schedule_cancel", postId, revisionId: post.scheduledRevisionId });
    return { version: post.version + 1 };
  });
}

/**
 * The scheduled-publish job. Idempotent: it publishes only while the post still carries exactly
 * this schedule version and revision, checked under the row lock, and publishing clears the
 * schedule, so a duplicate or delayed run finds nothing to do.
 */
export async function runScheduledPublish(database: Db, payload: { postId: string; revisionId: string; scheduleVersion: number }): Promise<"published" | "stale" | "blocked"> {
  const [snapshot] = await database.select().from(blogPosts).where(eq(blogPosts.id, payload.postId));
  const current = (p: PostRow | undefined) =>
    Boolean(p && !p.deletedAt && p.scheduleVersion === payload.scheduleVersion && p.scheduledRevisionId === payload.revisionId);
  if (!current(snapshot) || !snapshot) return "stale";
  const rev = await loadRevision(database, payload.postId, payload.revisionId);
  const check = await checkPublishable(database, snapshot, rev);
  if (Object.keys(check.errors).length) {
    await database.transaction(async (tx) => {
      const post = await lockPost(tx, payload.postId);
      if (!current(post)) return;
      await tx.update(blogPosts)
        .set({ scheduledRevisionId: null, scheduledFor: null, scheduleVersion: post.scheduleVersion + 1, version: post.version + 1 })
        .where(eq(blogPosts.id, post.id));
      await audit(tx, { actorId: null, action: "post.schedule_blocked", postId: post.id, revisionId: rev.id, summary: Object.values(check.errors).join(" ").slice(0, 480) });
    });
    return "blocked";
  }
  await promoteMedia(database, check.mediaIds);
  return withSlugConflict(() => database.transaction(async (tx) => {
    const post = await lockPost(tx, payload.postId);
    if (!current(post)) return "stale" as const;
    await applyPublication(tx, post, rev, null);
    return "published" as const;
  }));
}

/** Withdraws a post from the public site at once; revisions are kept. */
export async function unpublishPost(database: Db, editor: Editor, postId: string, expectedVersion: number) {
  assertCan(editor, "post:publish");
  return database.transaction(async (tx) => {
    const post = await lockPost(tx, postId);
    await assertVersion(tx, post, expectedVersion);
    if (post.status !== "published") throw new ServiceError(409, "not_published", "This post is not published.");
    await tx.update(blogPosts).set({
      status: "archived",
      archivedAt: new Date(),
      scheduledRevisionId: null,
      scheduledFor: null,
      scheduleVersion: post.scheduleVersion + 1,
      version: post.version + 1,
      updatedAt: new Date(),
    }).where(eq(blogPosts.id, postId));
    const generation = await bumpGeneration(tx);
    const notifyKey = await queueNotify(tx, { postId, generation, reason: "unpublish", revisionId: null, slug: post.slug });
    await audit(tx, { actorId: editor.id, action: "post.unpublish", postId, revisionId: post.publishedRevisionId });
    return { version: post.version + 1, notifyKey };
  });
}

/** Brings an archived post back as a draft. It stays off the site until it is published again. */
export async function restoreArchived(database: Db, editor: Editor, postId: string, expectedVersion: number) {
  assertCan(editor, "post:publish");
  return database.transaction(async (tx) => {
    const post = await lockPost(tx, postId);
    await assertVersion(tx, post, expectedVersion);
    if (post.status !== "archived") throw new ServiceError(409, "not_archived", "This post is not archived.");
    await tx.update(blogPosts).set({ status: "draft", archivedAt: null, version: post.version + 1, updatedAt: new Date() }).where(eq(blogPosts.id, postId));
    await audit(tx, { actorId: editor.id, action: "post.restore", postId });
    return { version: post.version + 1 };
  });
}

/**
 * Soft-deletes a post. Its URL stays reserved and answers 410 Gone if it was ever public, so a
 * deleted article is never silently replaced by an unrelated one.
 */
export async function deletePost(database: Db, editor: Editor, postId: string, expectedVersion: number) {
  assertCan(editor, "post:publish");
  return database.transaction(async (tx) => {
    const post = await lockPost(tx, postId);
    await assertVersion(tx, post, expectedVersion);
    const wasPublic = post.status === "published";
    await tx.update(blogPosts).set({
      status: "archived",
      archivedAt: post.archivedAt ?? new Date(),
      deletedAt: new Date(),
      scheduledRevisionId: null,
      scheduledFor: null,
      scheduleVersion: post.scheduleVersion + 1,
      version: post.version + 1,
      updatedAt: new Date(),
    }).where(eq(blogPosts.id, postId));
    let notifyKey: string | null = null;
    if (post.publishedRevisionId) {
      await tx.insert(blogRedirects).values({ sourcePath: `/blogs/${post.slug}`, targetPath: null, statusCode: 410, postId })
        .onConflictDoUpdate({ target: blogRedirects.sourcePath, set: { targetPath: null, statusCode: 410, updatedAt: new Date() }, setWhere: eq(blogRedirects.postId, postId) });
    }
    if (wasPublic) {
      const generation = await bumpGeneration(tx);
      notifyKey = await queueNotify(tx, { postId, generation, reason: "delete", revisionId: null, slug: post.slug });
    }
    await audit(tx, { actorId: editor.id, action: "post.delete", postId });
    return { notifyKey };
  });
}

/** Media referenced by any revision that is published or scheduled right now. */
export async function mediaInLiveUse(database: Db | Tx, mediaId: string): Promise<boolean> {
  const rows = await database.execute(sql`
    SELECT 1 FROM blog_revision_media rm
    JOIN blog_posts p ON p.published_revision_id = rm.revision_id OR p.scheduled_revision_id = rm.revision_id
    WHERE rm.media_id = ${mediaId} AND p.deleted_at IS NULL
    LIMIT 1`);
  return rows.length > 0;
}
