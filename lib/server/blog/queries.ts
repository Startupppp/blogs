import "server-only";
import { and, count, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { audit } from "../audit";
import { assertCan, assertCanEditPost, policy, type Editor } from "../auth/editor";
import { can } from "../auth/roles";
import type { Db } from "../db/client";
import { blogAuditEvents, blogAuthors, blogCategories, blogEditors, blogMedia, blogPostRevisions, blogPosts } from "../db/schema";
import { env } from "../env";
import { notFound, ServiceError } from "../errors";
import { publicationState } from "../jobs/runner";
import { previewUrlFor, renderedMedia } from "../media/urls";
import { lockPost } from "./posts";

export const POST_FILTERS = ["all", "draft", "scheduled", "published", "archived"] as const;
export type PostFilter = (typeof POST_FILTERS)[number];
const PAGE_SIZE = 25;

export type PostStatusLabel = "Draft" | "Scheduled" | "Published" | "Published · edits pending" | "Archived";

export function statusLabel(p: { status: string; scheduledRevisionId: string | null; publishedRevisionId: string | null; workingRevisionId: string | null; archivedAt: Date | null }): PostStatusLabel {
  if (p.archivedAt || p.status === "archived") return "Archived";
  if (p.scheduledRevisionId) return "Scheduled";
  if (p.status === "published") return p.workingRevisionId !== p.publishedRevisionId ? "Published · edits pending" : "Published";
  return "Draft";
}

/** Editorial post list. Writers see only the posts assigned to them. */
export async function listPostsForAdmin(database: Db, editor: Editor, opts: { filter: PostFilter; q: string; page: number }) {
  const conditions: SQL[] = [isNull(blogPosts.deletedAt)];
  if (!can(editor.role, "post:edit-any", policy())) conditions.push(eq(blogPosts.ownerEditorId, editor.id));
  if (opts.filter === "draft") conditions.push(eq(blogPosts.status, "draft"), isNull(blogPosts.scheduledRevisionId));
  if (opts.filter === "scheduled") conditions.push(isNotNull(blogPosts.scheduledRevisionId));
  if (opts.filter === "published") conditions.push(eq(blogPosts.status, "published"));
  if (opts.filter === "archived") conditions.push(eq(blogPosts.status, "archived"));
  if (opts.q) {
    conditions.push(sql`(to_tsvector('english', ${blogPosts.title} || ' ' || ${blogPosts.excerpt} || ' ' || ${blogPosts.searchText}) @@ websearch_to_tsquery('english', ${opts.q}) OR ${blogPosts.slug} LIKE ${`${opts.q.toLowerCase().replace(/[^a-z0-9-]/g, "")}%`})`);
  }
  const where = and(...conditions);
  const [rows, [total]] = await Promise.all([
    database
      .select({
        id: blogPosts.id, title: blogPosts.title, slug: blogPosts.slug, status: blogPosts.status,
        workingRevisionId: blogPosts.workingRevisionId, publishedRevisionId: blogPosts.publishedRevisionId,
        scheduledRevisionId: blogPosts.scheduledRevisionId, scheduledFor: blogPosts.scheduledFor,
        archivedAt: blogPosts.archivedAt, publishedAt: blogPosts.publishedAt, updatedAt: blogPosts.updatedAt,
        authorName: blogAuthors.name, ownerEmail: blogEditors.email,
        draftTitle: blogPostRevisions.title,
      })
      .from(blogPosts)
      .leftJoin(blogAuthors, eq(blogAuthors.id, blogPosts.authorId))
      .leftJoin(blogEditors, eq(blogEditors.id, blogPosts.ownerEditorId))
      .leftJoin(blogPostRevisions, eq(blogPostRevisions.id, blogPosts.workingRevisionId))
      .where(where)
      .orderBy(desc(blogPosts.updatedAt), desc(blogPosts.id))
      .limit(PAGE_SIZE)
      .offset((opts.page - 1) * PAGE_SIZE),
    database.select({ value: count() }).from(blogPosts).where(where),
  ]);
  return {
    items: rows.map((r) => ({ ...r, label: statusLabel(r), displayTitle: r.draftTitle || r.title })),
    total: total?.value ?? 0,
    pageSize: PAGE_SIZE,
  };
}

/** Everything the editor screen needs, authorised for this editor. Draft data never leaves the admin. */
export async function loadEditorState(database: Db, editor: Editor, postId: string) {
  const [post] = await database.select().from(blogPosts).where(eq(blogPosts.id, postId));
  if (!post || post.deletedAt) throw notFound("Post");
  assertCanEditPost(editor, post);
  const [rev] = post.workingRevisionId ? await database.select().from(blogPostRevisions).where(eq(blogPostRevisions.id, post.workingRevisionId)) : [];
  if (!rev) throw notFound("Working revision");

  const [authors, categories, events, state, owners] = await Promise.all([
    database.select({ id: blogAuthors.id, name: blogAuthors.name }).from(blogAuthors).where(isNull(blogAuthors.archivedAt)).orderBy(blogAuthors.name).limit(500),
    database.select({ id: blogCategories.id, name: blogCategories.name }).from(blogCategories).where(isNull(blogCategories.archivedAt)).orderBy(blogCategories.name).limit(200),
    database.select({ id: blogAuditEvents.id, action: blogAuditEvents.action, summary: blogAuditEvents.summary, createdAt: blogAuditEvents.createdAt, actor: blogEditors.email })
      .from(blogAuditEvents).leftJoin(blogEditors, eq(blogEditors.id, blogAuditEvents.actorId))
      .where(eq(blogAuditEvents.postId, postId)).orderBy(desc(blogAuditEvents.createdAt)).limit(20),
    publicationState(database, postId),
    can(editor.role, "post:reassign", policy())
      ? database.select({ id: blogEditors.id, email: blogEditors.email }).from(blogEditors).where(isNull(blogEditors.disabledAt)).orderBy(blogEditors.email).limit(500)
      : Promise.resolve([]),
  ]);

  const mediaIds = [...new Set([rev.coverMediaId, rev.socialMediaId, ...collectIds(rev.doc)].filter((x): x is string => Boolean(x)))];
  const mediaRows = mediaIds.length ? await database.select().from(blogMedia).where(inArray(blogMedia.id, mediaIds)) : [];
  const media = Object.fromEntries(mediaRows.map((m) => [m.id, mediaSummary(m)]));

  return {
    post: {
      id: post.id, status: post.status, label: statusLabel(post), version: post.version, slug: post.slug,
      publishedRevisionId: post.publishedRevisionId, scheduledFor: post.scheduledFor?.toISOString() ?? null,
      publishedAt: post.publishedAt?.toISOString() ?? null, ownerEditorId: post.ownerEditorId,
      hasPendingEdits: Boolean(post.publishedRevisionId) && post.workingRevisionId !== post.publishedRevisionId,
    },
    revision: {
      id: rev.id, seq: rev.seq, schemaVersion: rev.schemaVersion, doc: rev.doc, legacyHtml: rev.schemaVersion === 0 ? rev.html : null,
      title: rev.title, slug: rev.slug, excerpt: rev.excerpt, standfirst: rev.standfirst, seoTitle: rev.seoTitle, seoDescription: rev.seoDescription,
      coverMediaId: rev.coverMediaId, coverAlt: rev.coverAlt, coverCaption: rev.coverCaption, socialMediaId: rev.socialMediaId,
      authorId: rev.authorId, categoryId: rev.categoryId, tags: rev.tags, isFeatured: rev.isFeatured, ctaKey: rev.ctaKey,
      updatedAt: rev.updatedAt.toISOString(),
    },
    media,
    authors,
    categories,
    owners,
    events: events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    publication: state,
    publicOrigin: env().PUBLIC_SITE_ORIGIN,
    can: {
      publish: can(editor.role, "post:publish", policy()),
      reassign: can(editor.role, "post:reassign", policy()),
    },
  };
}

export type EditorState = Awaited<ReturnType<typeof loadEditorState>>;

export function mediaSummary(m: typeof blogMedia.$inferSelect) {
  const preview = m.status === "ready" ? renderedMedia(m.variants, previewUrlFor(m.id)) : null;
  return {
    id: m.id, status: m.status, fileName: m.fileName, width: m.width, height: m.height, altDefault: m.altDefault,
    credit: m.credit, license: m.license, sourceUrl: m.sourceUrl, focalX: m.focalX, focalY: m.focalY,
    failureReason: m.failureReason, promoted: Boolean(m.promotedAt), preview,
  };
}

export type MediaSummary = ReturnType<typeof mediaSummary>;

function collectIds(doc: unknown): string[] {
  const ids: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: unknown; attrs?: { mediaId?: unknown }; content?: unknown };
    if (n.type === "image" && typeof n.attrs?.mediaId === "string") ids.push(n.attrs.mediaId);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(doc);
  return ids;
}

/** Publishers hand a draft to a writer (or take it back). */
export async function reassignOwner(database: Db, editor: Editor, postId: string, ownerEditorId: string, expectedVersion: number) {
  assertCan(editor, "post:reassign");
  return database.transaction(async (tx) => {
    const post = await lockPost(tx, postId);
    if (post.version !== expectedVersion) throw new ServiceError(409, "version_conflict", "This post changed. Reload and try again.");
    const [owner] = await tx.select({ id: blogEditors.id }).from(blogEditors).where(and(eq(blogEditors.id, ownerEditorId), isNull(blogEditors.disabledAt)));
    if (!owner) throw notFound("Editor");
    await tx.update(blogPosts).set({ ownerEditorId, version: post.version + 1 }).where(eq(blogPosts.id, postId));
    await audit(tx, { actorId: editor.id, action: "post.reassign", postId, editorId: ownerEditorId });
    return { version: post.version + 1 };
  });
}
