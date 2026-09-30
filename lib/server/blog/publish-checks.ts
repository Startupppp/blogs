import "server-only";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { parseDocument } from "@/lib/content/document";
import { checkSlug } from "@/lib/content/slug";
import type { Db, Tx } from "../db/client";
import { blogAuthors, blogCategories, blogPosts, blogRedirects } from "../db/schema";
import { env } from "../env";
import { collectMediaIds, loadMedia, renderRevisionDoc, slugMessage, slugTakenByOther, type PostRow, type RevisionRow } from "./posts";

export const MIN_BODY_WORDS = 120;

export interface PublishCheck {
  /** Blocking: field name → message shown beside that field. */
  errors: Record<string, string>;
  /** Advisory: shown before publishing, never blocking. */
  warnings: string[];
  mediaIds: string[];
}

/**
 * The publication gate (CMS-08, CMS-09, CMS-14). Blocking failures are keyed by the field the
 * editor must fix; SEO lengths and missing credits are advice, not rules.
 */
export async function checkPublishable(database: Db | Tx, post: PostRow, rev: RevisionRow): Promise<PublishCheck> {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];

  const parsed = parseDocument(rev.doc);
  if (!parsed.success) {
    errors.doc = rev.schemaVersion === 0
      ? "This post was written in the old editor. Open it in the editor and save once to convert it."
      : "The article body contains content that cannot be published.";
    return { errors, warnings, mediaIds: [] };
  }
  const doc = parsed.data;
  const bodyIds = collectMediaIds(doc);
  const mediaIds = [...new Set([...bodyIds, rev.coverMediaId, rev.socialMediaId].filter((x): x is string => Boolean(x)))];
  const media = await loadMedia(database, mediaIds);
  const rendered = renderRevisionDoc(doc, media);

  if (!rev.title.trim()) errors.title = "Add a title.";
  const slugProblem = checkSlug(rev.slug);
  if (slugProblem) errors.slug = slugMessage(slugProblem);
  else if (await slugTakenByOther(database, post.id, rev.slug)) errors.slug = "Another post already uses this URL.";
  if (rev.excerpt.trim().length < 20) errors.excerpt = "Write an excerpt of at least 20 characters.";
  if (rendered.wordCount < MIN_BODY_WORDS) errors.doc = `The article needs at least ${MIN_BODY_WORDS} words (it has ${rendered.wordCount}).`;

  if (!rev.authorId) errors.authorId = "Choose an author.";
  else {
    const [author] = await database.select({ id: blogAuthors.id }).from(blogAuthors)
      .where(and(eq(blogAuthors.id, rev.authorId), isNull(blogAuthors.archivedAt)));
    if (!author) errors.authorId = "The chosen author no longer exists.";
  }
  if (!rev.categoryId) errors.categoryId = "Choose a primary category.";
  else {
    const [category] = await database.select({ id: blogCategories.id }).from(blogCategories)
      .where(and(eq(blogCategories.id, rev.categoryId), isNull(blogCategories.archivedAt)));
    if (!category) errors.categoryId = "The chosen category no longer exists.";
  }

  const cover = rev.coverMediaId ? media.get(rev.coverMediaId) : undefined;
  if (!rev.coverMediaId) errors.coverMediaId = "Add a cover image.";
  else if (!cover || cover.status !== "ready") errors.coverMediaId = mediaStateMessage(cover?.status);
  else if (!rev.coverAlt?.trim()) errors.coverAlt = "Describe the cover image for people who cannot see it.";

  if (rev.socialMediaId) {
    const social = media.get(rev.socialMediaId);
    if (!social || social.status !== "ready") errors.socialMediaId = mediaStateMessage(social?.status);
  }
  for (const id of bodyIds) {
    const m = media.get(id);
    if (!m || m.status !== "ready") {
      errors.doc = `An image in the body is not ready: ${mediaStateMessage(m?.status)}`;
      break;
    }
  }

  if (rendered.imagesMissingAlt) warnings.push(`${rendered.imagesMissingAlt} body image(s) have no alt text. Leave alt empty only for decorative images.`);
  const uncredited = mediaIds.filter((id) => media.get(id)?.status === "ready" && !media.get(id)?.credit);
  if (uncredited.length) warnings.push(`${uncredited.length} image(s) have no source credit.`);
  const seoTitle = rev.seoTitle ?? rev.title;
  if (seoTitle.length > 60) warnings.push(`The search title is ${seoTitle.length} characters; around 60 usually displays in full.`);
  const seoDescription = rev.seoDescription ?? rev.excerpt;
  if (seoDescription.length > 160) warnings.push(`The search description is ${seoDescription.length} characters; around 160 usually displays in full.`);
  if (!rev.seoTitle) warnings.push("No search title set; the article title will be used.");
  if (!rev.seoDescription) warnings.push("No search description set; the excerpt will be used.");
  const broken = await brokenInternalLinks(database, rendered.links);
  if (broken.length) warnings.push(`Internal link(s) not found on the site: ${broken.slice(0, 5).join(", ")}`);

  return { errors, warnings, mediaIds };
}

function mediaStateMessage(status: string | undefined): string {
  switch (status) {
    case "pending": return "The image upload was not finished. Upload it again.";
    case "processing": return "The image is still being processed. Try again in a moment.";
    case "failed": return "The image could not be processed. Replace it.";
    default: return "The image no longer exists. Choose another.";
  }
}

/** `/blogs/<slug>` links (relative or on the public origin) that resolve to no live post or redirect. */
async function brokenInternalLinks(database: Db | Tx, links: string[]): Promise<string[]> {
  const origin = env().PUBLIC_SITE_ORIGIN;
  const slugs = new Map<string, string>();
  for (const link of links) {
    const path = link.startsWith(origin) ? link.slice(origin.length) : link;
    const match = /^\/blogs\/([a-z0-9-]+)\/?(?:[#?].*)?$/.exec(path);
    if (match?.[1] && !["archive", "search", "editorial-policy"].includes(match[1])) slugs.set(match[1], link);
  }
  if (slugs.size === 0) return [];
  const live = await database.select({ slug: blogPosts.slug }).from(blogPosts).where(and(
    inArray(blogPosts.slug, [...slugs.keys()]),
    eq(blogPosts.status, "published"),
    isNull(blogPosts.archivedAt),
    isNull(blogPosts.deletedAt),
    lte(blogPosts.publishedAt, sql`(now() AT TIME ZONE 'UTC')`),
  ));
  const redirected = await database.select({ source: blogRedirects.sourcePath }).from(blogRedirects)
    .where(and(eq(blogRedirects.statusCode, 301), inArray(blogRedirects.sourcePath, [...slugs.keys()].map((s) => `/blogs/${s}`))));
  const ok = new Set([...live.map((r) => r.slug), ...redirected.map((r) => r.source.slice("/blogs/".length))]);
  return [...slugs.entries()].filter(([slug]) => !ok.has(slug)).map(([, link]) => link);
}
