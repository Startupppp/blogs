import "server-only";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { checkSlug, slugify } from "@/lib/content/slug";
import { audit } from "../audit";
import { assertCan, type Editor } from "../auth/editor";
import type { Db } from "../db/client";
import { blogAuthors, blogCategories, blogMedia, blogPosts } from "../db/schema";
import { env } from "../env";
import { ServiceError, notFound } from "../errors";
import { promoteMedia } from "../media/promote";
import { publicUrlFor, renderedMedia } from "../media/urls";

const optional = (max: number) => z.string().trim().max(max).transform((v) => (v.length ? v : null)).nullable();
const handle = (max: number) => optional(max).refine((v) => v === null || /^[A-Za-z0-9_.-]+$/.test(v), "Use the handle only, without a URL");

export const authorInputSchema = z.object({
  authorId: z.string().uuid().nullable(),
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().max(120),
  role: optional(100),
  bio: optional(2000),
  twitter: handle(100),
  linkedin: handle(200),
  email: z.string().trim().max(320).transform((v) => (v.length ? v.toLowerCase() : null)).nullable()
    .refine((v) => v === null || z.string().email().safeParse(v).success, "Enter a valid email"),
  avatarMediaId: z.string().uuid().nullable(),
}).strict();

export const categoryInputSchema = z.object({
  categoryId: z.string().uuid().nullable(),
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().max(100),
  description: optional(2000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  seoTitle: optional(256),
  seoDescription: optional(320),
}).strict();

function uniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return (e.cause?.code ?? e.code) === "23505";
}

/** A public slug is fixed once the entity exists: renaming never breaks /blogs/author/<slug>. */
function newSlug(input: string, name: string): string {
  const slug = input ? input.toLowerCase() : slugify(name);
  const problem = checkSlug(slug);
  if (problem) throw new ServiceError(422, "invalid_slug", "Choose a different URL slug.", { slug: problem === "reserved" ? "This word is reserved." : "Use lowercase letters, numbers and hyphens." });
  return slug;
}

export async function listAuthors(database: Db) {
  return database
    .select({
      id: blogAuthors.id, name: blogAuthors.name, slug: blogAuthors.slug, role: blogAuthors.role, bio: blogAuthors.bio,
      twitter: blogAuthors.twitter, linkedin: blogAuthors.linkedin, email: blogAuthors.email, avatar: blogAuthors.avatar,
      archivedAt: blogAuthors.archivedAt,
      // The outer column is written out: Drizzle interpolates a column reference unqualified, and
      // a bare "id" inside this subquery would bind to blog_posts.id, counting nothing.
      livePosts: sql<number>`(SELECT count(*)::int FROM blog_posts p WHERE p.author_id = "blog_authors"."id" AND p.status = 'published' AND p.deleted_at IS NULL)`,
    })
    .from(blogAuthors).orderBy(asc(blogAuthors.name)).limit(500);
}

export async function saveAuthor(database: Db, editor: Editor, input: z.infer<typeof authorInputSchema>) {
  assertCan(editor, "taxonomy:manage");
  let avatar: string | undefined;
  if (input.avatarMediaId) {
    const [m] = await database.select().from(blogMedia).where(eq(blogMedia.id, input.avatarMediaId));
    if (!m || m.status !== "ready") throw new ServiceError(422, "media_not_ready", "The portrait is not ready.", { avatarMediaId: "Choose a processed image." });
    await promoteMedia(database, [m.id]);
    avatar = renderedMedia(m.variants.filter((v) => v.width <= 768), publicUrlFor(env().MEDIA_PUBLIC_ORIGIN))?.src;
  }
  const values = { name: input.name, role: input.role, bio: input.bio, twitter: input.twitter, linkedin: input.linkedin, email: input.email, ...(avatar ? { avatar } : {}) };
  try {
    if (input.authorId) {
      const [row] = await database.update(blogAuthors).set(values).where(eq(blogAuthors.id, input.authorId)).returning({ id: blogAuthors.id });
      if (!row) throw notFound("Author");
      await audit(database, { actorId: editor.id, action: "author.update", authorId: row.id });
      return row;
    }
    const [row] = await database.insert(blogAuthors).values({ ...values, slug: newSlug(input.slug, input.name) }).returning({ id: blogAuthors.id });
    if (!row) throw new Error("author insert returned nothing");
    await audit(database, { actorId: editor.id, action: "author.create", authorId: row.id });
    return row;
  } catch (error) {
    if (uniqueViolation(error)) throw new ServiceError(409, "duplicate", "An author with that URL or email already exists.", { slug: "Already in use." });
    throw error;
  }
}

/**
 * Archiving hides an author from pickers and public pages. It is refused while a published post
 * credits them: reassign those posts (and republish) first. Authors are never hard-deleted, so
 * revision history keeps its attribution.
 */
export async function archiveAuthor(database: Db, editor: Editor, authorId: string, archived: boolean) {
  assertCan(editor, "taxonomy:manage");
  if (archived) {
    const [live] = await database.select({ value: count() }).from(blogPosts)
      .where(and(eq(blogPosts.authorId, authorId), eq(blogPosts.status, "published"), isNull(blogPosts.deletedAt)));
    if ((live?.value ?? 0) > 0) throw new ServiceError(409, "in_use", `${live?.value} published post(s) credit this author. Reassign them first.`);
  }
  await database.update(blogAuthors).set({ archivedAt: archived ? new Date() : null }).where(eq(blogAuthors.id, authorId));
  await audit(database, { actorId: editor.id, action: archived ? "author.archive" : "author.unarchive", authorId });
}

export async function listCategories(database: Db) {
  return database
    .select({
      id: blogCategories.id, name: blogCategories.name, slug: blogCategories.slug, description: blogCategories.description,
      color: blogCategories.color, seoTitle: blogCategories.seoTitle, seoDescription: blogCategories.seoDescription, archivedAt: blogCategories.archivedAt,
      livePosts: sql<number>`(SELECT count(*)::int FROM blog_posts p WHERE p.category_id = "blog_categories"."id" AND p.status = 'published' AND p.deleted_at IS NULL)`,
    })
    .from(blogCategories).orderBy(asc(blogCategories.name)).limit(200);
}

export async function saveCategory(database: Db, editor: Editor, input: z.infer<typeof categoryInputSchema>) {
  assertCan(editor, "taxonomy:manage");
  const values = { name: input.name, description: input.description, color: input.color, seoTitle: input.seoTitle, seoDescription: input.seoDescription };
  try {
    if (input.categoryId) {
      const [row] = await database.update(blogCategories).set(values).where(eq(blogCategories.id, input.categoryId)).returning({ id: blogCategories.id });
      if (!row) throw notFound("Category");
      await audit(database, { actorId: editor.id, action: "category.update", categoryId: row.id });
      return row;
    }
    const [row] = await database.insert(blogCategories).values({ ...values, slug: newSlug(input.slug, input.name) }).returning({ id: blogCategories.id });
    if (!row) throw new Error("category insert returned nothing");
    await audit(database, { actorId: editor.id, action: "category.create", categoryId: row.id });
    return row;
  } catch (error) {
    if (uniqueViolation(error)) throw new ServiceError(409, "duplicate", "A category with that name or URL already exists.", { name: "Already in use." });
    throw error;
  }
}

export async function archiveCategory(database: Db, editor: Editor, categoryId: string, archived: boolean) {
  assertCan(editor, "taxonomy:manage");
  if (archived) {
    const [live] = await database.select({ value: count() }).from(blogPosts)
      .where(and(eq(blogPosts.categoryId, categoryId), eq(blogPosts.status, "published"), isNull(blogPosts.deletedAt)));
    if ((live?.value ?? 0) > 0) throw new ServiceError(409, "in_use", `${live?.value} published post(s) use this category. Move them first.`);
  }
  await database.update(blogCategories).set({ archivedAt: archived ? new Date() : null }).where(eq(blogCategories.id, categoryId));
  await audit(database, { actorId: editor.id, action: archived ? "category.archive" : "category.unarchive", categoryId });
}
