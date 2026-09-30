import "server-only";
import { and, desc, eq, inArray, isNull, max, ne, sql } from "drizzle-orm";
import { DOCUMENT_SCHEMA_VERSION, EMPTY_DOCUMENT, RENDERER_VERSION, parseDocument, type ArticleDocument } from "@/lib/content/document";
import { readingTimeMinutes, renderDocument } from "@/lib/content/render";
import { checkSlug, normalizeTags, slugify } from "@/lib/content/slug";
import { audit } from "../audit";
import { assertCanEditPost, type Editor } from "../auth/editor";
import type { Db, Tx } from "../db/client";
import { blogMedia, blogPostRevisions, blogPosts, blogRedirects, blogRevisionMedia, type MediaVariant } from "../db/schema";
import { env } from "../env";
import { ServiceError, notFound } from "../errors";
import { publicUrlFor, renderedMedia } from "../media/urls";
import type { DraftInput } from "./inputs";

export type PostRow = typeof blogPosts.$inferSelect;
export type RevisionRow = typeof blogPostRevisions.$inferSelect;

/** Locks the post row for the rest of the transaction. Deleted posts are treated as missing. */
export async function lockPost(tx: Tx, postId: string): Promise<PostRow> {
  const [post] = await tx.select().from(blogPosts).where(eq(blogPosts.id, postId)).for("update");
  if (!post || post.deletedAt) throw notFound("Post");
  return post;
}

/** What the conflict dialog compares against: the server's current working draft. */
async function conflictSnapshot(tx: Tx, post: PostRow) {
  const [rev] = post.workingRevisionId
    ? await tx.select().from(blogPostRevisions).where(eq(blogPostRevisions.id, post.workingRevisionId))
    : [];
  return {
    version: post.version,
    title: rev?.title ?? post.title,
    excerpt: rev?.excerpt ?? post.excerpt,
    text: (rev?.searchText ?? "").slice(0, 20_000),
    doc: rev?.doc ?? null,
    savedAt: (rev?.updatedAt ?? post.updatedAt).toISOString(),
  };
}

export async function assertVersion(tx: Tx, post: PostRow, expectedVersion: number): Promise<void> {
  if (post.version === expectedVersion) return;
  throw new ServiceError(409, "version_conflict", "This post was changed by someone else since you opened it.", {}, await conflictSnapshot(tx, post));
}

/** Media rows by id with their processed variants, for rendering and validation. */
export async function loadMedia(database: Db | Tx, ids: string[]) {
  if (ids.length === 0) return new Map<string, typeof blogMedia.$inferSelect>();
  const rows = await database.select().from(blogMedia).where(inArray(blogMedia.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

export function renderRevisionDoc(doc: ArticleDocument, media: Map<string, { status: string; variants: MediaVariant[] }>) {
  const urlFor = publicUrlFor(env().MEDIA_PUBLIC_ORIGIN);
  return renderDocument(doc, (id) => {
    const m = media.get(id);
    return m && m.status === "ready" ? renderedMedia(m.variants, urlFor) : null;
  });
}

/** Whether `/blogs/<slug>` is free for this post: no other post and no other post's redirect. */
export async function slugTakenByOther(database: Db | Tx, postId: string, slug: string): Promise<boolean> {
  const [post] = await database.select({ id: blogPosts.id }).from(blogPosts)
    .where(and(eq(blogPosts.slug, slug), ne(blogPosts.id, postId))).limit(1);
  if (post) return true;
  const [redirect] = await database.select({ postId: blogRedirects.postId }).from(blogRedirects)
    .where(eq(blogRedirects.sourcePath, `/blogs/${slug}`)).limit(1);
  return Boolean(redirect && redirect.postId !== postId);
}

export async function createPost(database: Db, editor: Editor): Promise<{ postId: string }> {
  return database.transaction(async (tx) => {
    const placeholder = `untitled-${crypto.randomUUID().slice(0, 8)}`;
    const [post] = await tx.insert(blogPosts).values({
      title: "Untitled draft",
      slug: placeholder,
      excerpt: "",
      content: "",
      coverImage: "",
      status: "draft",
      isFeatured: false,
      tags: [],
      scheduleVersion: 0,
      version: 1,
      searchText: "",
      authorId: editor.authorId,
      ownerEditorId: editor.id,
    }).returning({ id: blogPosts.id });
    if (!post) throw new Error("post insert returned nothing");
    const [rev] = await tx.insert(blogPostRevisions).values({
      postId: post.id,
      seq: 1,
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      rendererVersion: RENDERER_VERSION,
      doc: EMPTY_DOCUMENT,
      html: "",
      searchText: "",
      readingTime: 1,
      title: "",
      slug: "",
      excerpt: "",
      authorId: editor.authorId,
      tags: [],
      isFeatured: false,
      createdBy: editor.id,
    }).returning({ id: blogPostRevisions.id });
    if (!rev) throw new Error("revision insert returned nothing");
    await tx.update(blogPosts).set({ workingRevisionId: rev.id }).where(eq(blogPosts.id, post.id));
    await audit(tx, { actorId: editor.id, action: "post.create", postId: post.id, revisionId: rev.id });
    return { postId: post.id };
  });
}

export interface SaveResult {
  version: number;
  revisionId: string;
  savedAt: string;
  warnings: Record<string, string>;
}

/**
 * Autosave. Writes the working revision only — the published projection on `blog_posts` is never
 * touched, so the live article is unchanged until someone publishes. A frozen working revision
 * (published, scheduled or checkpointed) is never edited in place: the save starts a new revision.
 * A stale `expectedVersion` is a 409 carrying the server's draft for the conflict dialog.
 */
export async function saveDraft(database: Db, editor: Editor, input: DraftInput): Promise<SaveResult> {
  const parsedDoc = parseDocument(input.doc);
  if (!parsedDoc.success) {
    throw new ServiceError(422, "invalid_document", "The article body contains content the editor cannot save.", { doc: parsedDoc.error.issues[0]?.message ?? "Invalid content" });
  }
  const doc = parsedDoc.data;
  const slug = input.slug ? input.slug.toLowerCase() : slugify(input.title);
  const tags = normalizeTags(input.tags);

  return database.transaction(async (tx) => {
    const post = await lockPost(tx, input.postId);
    assertCanEditPost(editor, post);
    await assertVersion(tx, post, input.expectedVersion);

    const bodyIds = collectMediaIds(doc);
    const referenced = [...new Set([...bodyIds, input.coverMediaId, input.socialMediaId].filter((x): x is string => Boolean(x)))];
    const media = await loadMedia(tx, referenced);
    for (const id of referenced) {
      const m = media.get(id);
      if (!m || m.status === "deleted") throw new ServiceError(422, "media_missing", "An image in this post no longer exists.", { media: id });
    }

    const rendered = renderRevisionDoc(doc, media);
    const values = {
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      rendererVersion: RENDERER_VERSION,
      doc,
      html: rendered.html,
      searchText: rendered.text.slice(0, 200_000),
      readingTime: readingTimeMinutes(rendered.wordCount),
      title: input.title,
      slug,
      excerpt: input.excerpt,
      standfirst: input.standfirst,
      seoTitle: input.seoTitle,
      seoDescription: input.seoDescription,
      coverMediaId: input.coverMediaId,
      coverAlt: input.coverAlt,
      coverCaption: input.coverCaption,
      socialMediaId: input.socialMediaId,
      authorId: input.authorId,
      categoryId: input.categoryId,
      tags,
      isFeatured: input.isFeatured,
      ctaKey: input.ctaKey,
      updatedAt: new Date(),
    };

    const [working] = post.workingRevisionId
      ? await tx.select().from(blogPostRevisions).where(eq(blogPostRevisions.id, post.workingRevisionId))
      : [];
    let revisionId: string;
    if (working && !working.frozenAt) {
      await tx.update(blogPostRevisions).set(values).where(eq(blogPostRevisions.id, working.id));
      revisionId = working.id;
    } else {
      const [{ next } = { next: 1 }] = await tx
        .select({ next: sql<number>`coalesce(${max(blogPostRevisions.seq)}, 0) + 1` })
        .from(blogPostRevisions).where(eq(blogPostRevisions.postId, post.id));
      const [created] = await tx.insert(blogPostRevisions)
        .values({ ...values, postId: post.id, seq: Number(next), createdBy: editor.id, legacyCoverUrl: working?.legacyCoverUrl ?? null })
        .returning({ id: blogPostRevisions.id });
      if (!created) throw new Error("revision insert returned nothing");
      revisionId = created.id;
    }

    await tx.delete(blogRevisionMedia).where(eq(blogRevisionMedia.revisionId, revisionId));
    const links = [
      ...bodyIds.map((mediaId) => ({ revisionId, mediaId, placement: "body" as const })),
      ...(input.coverMediaId ? [{ revisionId, mediaId: input.coverMediaId, placement: "cover" as const }] : []),
      ...(input.socialMediaId ? [{ revisionId, mediaId: input.socialMediaId, placement: "social" as const }] : []),
    ];
    if (links.length) await tx.insert(blogRevisionMedia).values(links).onConflictDoNothing();

    const warnings: Record<string, string> = {};
    const problem = checkSlug(slug);
    if (problem) warnings.slug = slugMessage(problem);
    else if (await slugTakenByOther(tx, post.id, slug)) warnings.slug = "Another post already uses this URL.";

    // A never-published post mirrors its draft title and reserves its slug so it is listable.
    const neverPublished = !post.publishedRevisionId;
    const mirror = neverPublished
      ? { title: input.title || "Untitled draft", excerpt: input.excerpt, ...(warnings.slug || !slug ? {} : { slug }) }
      : {};
    const [updated] = await tx.update(blogPosts)
      .set({ ...mirror, version: post.version + 1, workingRevisionId: revisionId, updatedAt: new Date() })
      .where(eq(blogPosts.id, post.id))
      .returning({ version: blogPosts.version });
    if (!updated) throw new Error("post update returned nothing");
    return { version: updated.version, revisionId, savedAt: new Date().toISOString(), warnings };
  });
}

export function slugMessage(problem: NonNullable<ReturnType<typeof checkSlug>>): string {
  switch (problem) {
    case "empty": return "Add a URL slug or a title.";
    case "format": return "Use lowercase letters, numbers and single hyphens.";
    case "reserved": return "This word is reserved for a site page. Try adding a word, e.g. \"-guide\".";
    case "too-long": return "Keep the slug under 120 characters.";
  }
}

export function collectMediaIds(doc: { content: unknown[] }): string[] {
  const ids: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const n = node as { type?: string; attrs?: { mediaId?: string }; content?: unknown[] };
      if (n.type === "image" && n.attrs?.mediaId) ids.push(n.attrs.mediaId);
      if (Array.isArray(n.content)) walk(n.content);
    }
  };
  walk(doc.content);
  return [...new Set(ids)];
}

/** Freezes the working revision as a named checkpoint; the next save starts a new revision. */
export async function checkpoint(database: Db, editor: Editor, postId: string, expectedVersion: number, summary: string) {
  return database.transaction(async (tx) => {
    const post = await lockPost(tx, postId);
    assertCanEditPost(editor, post);
    await assertVersion(tx, post, expectedVersion);
    if (!post.workingRevisionId) throw notFound("Working revision");
    await tx.update(blogPostRevisions)
      .set({ frozenAt: new Date(), changeSummary: summary.slice(0, 500) || "Checkpoint" })
      .where(and(eq(blogPostRevisions.id, post.workingRevisionId), isNull(blogPostRevisions.frozenAt)));
    const [updated] = await tx.update(blogPosts).set({ version: post.version + 1 }).where(eq(blogPosts.id, postId)).returning({ version: blogPosts.version });
    await audit(tx, { actorId: editor.id, action: "revision.checkpoint", postId, revisionId: post.workingRevisionId, summary });
    return { version: updated?.version ?? post.version + 1 };
  });
}

/**
 * Restores an old revision into a NEW working revision. History is never rewritten and nothing is
 * republished: the restored content goes live only when someone publishes it.
 */
export async function restoreRevision(database: Db, editor: Editor, postId: string, revisionId: string, expectedVersion: number) {
  return database.transaction(async (tx) => {
    const post = await lockPost(tx, postId);
    assertCanEditPost(editor, post);
    await assertVersion(tx, post, expectedVersion);
    const [source] = await tx.select().from(blogPostRevisions)
      .where(and(eq(blogPostRevisions.id, revisionId), eq(blogPostRevisions.postId, postId)));
    if (!source) throw notFound("Revision");
    const [{ next } = { next: 1 }] = await tx
      .select({ next: sql<number>`coalesce(${max(blogPostRevisions.seq)}, 0) + 1` })
      .from(blogPostRevisions).where(eq(blogPostRevisions.postId, postId));
    const { id: _id, seq: _seq, frozenAt: _f, createdAt: _c, updatedAt: _u, createdBy: _b, changeSummary: _s, ...content } = source;
    const [created] = await tx.insert(blogPostRevisions)
      .values({ ...content, postId, seq: Number(next), createdBy: editor.id, changeSummary: `Restored from revision ${source.seq}` })
      .returning({ id: blogPostRevisions.id });
    if (!created) throw new Error("revision insert returned nothing");
    const media = await tx.select().from(blogRevisionMedia).where(eq(blogRevisionMedia.revisionId, source.id));
    if (media.length) await tx.insert(blogRevisionMedia).values(media.map((m) => ({ ...m, revisionId: created.id })));
    const [updated] = await tx.update(blogPosts)
      .set({ workingRevisionId: created.id, version: post.version + 1, updatedAt: new Date() })
      .where(eq(blogPosts.id, postId)).returning({ version: blogPosts.version });
    await audit(tx, { actorId: editor.id, action: "revision.restore", postId, revisionId: created.id, summary: `from revision ${source.seq}` });
    return { version: updated?.version ?? post.version + 1, revisionId: created.id };
  });
}

export async function listRevisions(database: Db, editor: Editor, postId: string) {
  const [post] = await database.select().from(blogPosts).where(eq(blogPosts.id, postId));
  if (!post || post.deletedAt) throw notFound("Post");
  assertCanEditPost(editor, post);
  const rows = await database
    .select({
      id: blogPostRevisions.id,
      seq: blogPostRevisions.seq,
      title: blogPostRevisions.title,
      changeSummary: blogPostRevisions.changeSummary,
      frozenAt: blogPostRevisions.frozenAt,
      createdAt: blogPostRevisions.createdAt,
      updatedAt: blogPostRevisions.updatedAt,
      createdBy: blogPostRevisions.createdBy,
      wordCount: sql<number>`coalesce(array_length(regexp_split_to_array(nullif(${blogPostRevisions.searchText}, ''), '\\s+'), 1), 0)`,
    })
    .from(blogPostRevisions)
    .where(eq(blogPostRevisions.postId, postId))
    .orderBy(desc(blogPostRevisions.seq))
    .limit(200);
  return {
    post,
    revisions: rows.map((r) => ({
      ...r,
      isWorking: r.id === post.workingRevisionId,
      isPublished: r.id === post.publishedRevisionId,
      isScheduled: r.id === post.scheduledRevisionId,
    })),
  };
}
