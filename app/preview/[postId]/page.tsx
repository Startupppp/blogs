import { and, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { parseDocument } from "@/lib/content/document";
import { readingTimeMinutes, renderDocument } from "@/lib/content/render";
import { AuthError, assertCanEditPost } from "@/lib/server/auth/editor";
import { currentEditor } from "@/lib/server/auth/session";
import { collectMediaIds, loadMedia } from "@/lib/server/blog/posts";
import { db } from "@/lib/server/db/client";
import { blogAuthors, blogCategories, blogPostRevisions, blogPosts } from "@/lib/server/db/schema";
import { previewUrlFor, renderedMedia } from "@/lib/server/media/urls";

export const dynamic = "force-dynamic";
export const metadata = { title: "Preview", robots: { index: false, follow: false, nocache: true } };

/**
 * Private preview of a draft, rendered by the SAME renderer that produces published HTML, with
 * images served through the authenticated proxy. Requires a signed-in editor allowed to edit the
 * post; a shared link shows nothing to anyone else.
 */
export default async function PreviewPage({ params, searchParams }: { params: Promise<{ postId: string }>; searchParams: Promise<{ revision?: string }> }) {
  const [{ postId }, { revision }] = await Promise.all([params, searchParams]);
  const ids = z.object({ postId: z.string().uuid(), revision: z.string().uuid().optional() }).safeParse({ postId, revision });
  if (!ids.success) notFound();
  const editor = await currentEditor();
  if (!editor) redirect("/login");

  const [post] = await db().select().from(blogPosts).where(eq(blogPosts.id, ids.data.postId));
  if (!post || post.deletedAt) notFound();
  try {
    assertCanEditPost(editor, post);
  } catch (error) {
    if (error instanceof AuthError) notFound();
    throw error;
  }
  const revisionId = ids.data.revision ?? post.workingRevisionId;
  if (!revisionId) notFound();
  const [rev] = await db().select().from(blogPostRevisions).where(and(eq(blogPostRevisions.id, revisionId), eq(blogPostRevisions.postId, post.id)));
  if (!rev) notFound();

  const [[author], [category]] = await Promise.all([
    rev.authorId ? db().select().from(blogAuthors).where(eq(blogAuthors.id, rev.authorId)) : Promise.resolve([]),
    rev.categoryId ? db().select().from(blogCategories).where(eq(blogCategories.id, rev.categoryId)) : Promise.resolve([]),
  ]);

  const parsed = parseDocument(rev.doc);
  const mediaIds = [rev.coverMediaId, ...(parsed.success ? collectMediaIds(parsed.data) : [])].filter((x): x is string => Boolean(x));
  const media = await loadMedia(db(), mediaIds);
  const rendered = parsed.success
    ? renderDocument(parsed.data, (id) => {
        const m = media.get(id);
        return m?.status === "ready" ? renderedMedia(m.variants, previewUrlFor(id)) : null;
      })
    : null;
  const cover = rev.coverMediaId ? media.get(rev.coverMediaId) : undefined;
  const coverImg = cover?.status === "ready" ? renderedMedia(cover.variants, previewUrlFor(cover.id)) : null;

  return (
    <div className="min-h-dvh bg-paper">
      <div role="status" className="sticky top-0 z-20 bg-accent px-4 py-2 text-center text-sm font-medium text-white">
        Preview — revision #{rev.seq}{post.status === "published" && post.publishedRevisionId === rev.id ? " (live version)" : ", not published"}. Only signed-in editors can see this page.
      </div>
      <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <nav aria-label="Breadcrumb" className="text-sm text-muted">Journal{category ? ` / ${category.name}` : ""}</nav>
        {category ? <p className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-accent">{category.name}</p> : null}
        <h1 className="mt-3 font-serif text-4xl leading-tight sm:text-5xl">{rev.title || "Untitled draft"}</h1>
        {rev.standfirst ? <p className="mt-4 font-serif text-xl text-muted">{rev.standfirst}</p> : null}
        <p className="mt-6 text-sm text-muted">
          {author?.name ?? "No author"} · {readingTimeMinutes(rendered?.wordCount ?? 0)} min read
        </p>
        {coverImg ? (
          <figure className="mt-8">
            <img src={coverImg.src} srcSet={coverImg.srcset} sizes="(max-width: 768px) 100vw, 768px" width={coverImg.width} height={coverImg.height} alt={rev.coverAlt ?? ""} className="h-auto w-full rounded" />
            {rev.coverCaption ? <figcaption className="mt-2 text-sm text-muted">{rev.coverCaption}</figcaption> : null}
          </figure>
        ) : null}
        {rendered ? (
          <div className="article mt-10" dangerouslySetInnerHTML={{ __html: rendered.html }} />
        ) : (
          <div className="mt-10 rounded-md bg-warn-soft p-4 text-warn">
            This revision was written in the old editor and has not been converted. Open it in the editor and save to convert it.
          </div>
        )}
      </article>
    </div>
  );
}

