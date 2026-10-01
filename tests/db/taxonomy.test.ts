import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/server/db/client";
import { blogAuthors, blogCategories, blogPosts } from "@/lib/server/db/schema";
import { AuthError, type Editor } from "@/lib/server/auth/editor";
import { ServiceError } from "@/lib/server/errors";
import { createPost, saveDraft } from "@/lib/server/blog/posts";
import { publishNow } from "@/lib/server/blog/publish";
import {
  archiveAuthor,
  archiveCategory,
  listAuthors,
  listCategories,
  saveAuthor,
  saveCategory,
} from "@/lib/server/blog/taxonomy";
import { longDoc, makeAuthor, makeCategory, makeEditor, testJpeg, uploadImage } from "./fixtures";

async function expectServiceError(p: Promise<unknown>, status: number, code?: string) {
  const error = await p.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).status).toBe(status);
  if (code) expect((error as ServiceError).code).toBe(code);
  return error as ServiceError;
}

const author = (over: Partial<Parameters<typeof saveAuthor>[2]> = {}) => ({
  authorId: null, name: "Priya Nair", slug: "", role: "Operations lead", bio: null,
  twitter: null, linkedin: null, email: null, avatarMediaId: null, ...over,
});

const category = (over: Partial<Parameters<typeof saveCategory>[2]> = {}) => ({
  categoryId: null, name: "People operations", slug: "", description: null,
  color: null, seoTitle: null, seoDescription: null, ...over,
});

let admin: Editor;
let writer: Editor;
let cover: string;

beforeAll(async () => {
  admin = await makeEditor("admin");
  writer = await makeEditor("writer");
  cover = await uploadImage(admin, await testJpeg());
});

describe("authors and categories", () => {
  it("refuses a writer, who has no taxonomy capability", async () => {
    await expect(saveAuthor(db(), writer, author())).rejects.toBeInstanceOf(AuthError);
    await expect(saveCategory(db(), writer, category())).rejects.toBeInstanceOf(AuthError);
    await expect(archiveAuthor(db(), writer, crypto.randomUUID(), true)).rejects.toBeInstanceOf(AuthError);
  });

  it("derives a slug from the name and keeps it when the name later changes", async () => {
    const created = await saveAuthor(db(), admin, author({ name: `Priya Nair ${Date.now().toString(36)}` }));
    const [before] = await db().select({ slug: blogAuthors.slug }).from(blogAuthors).where(eq(blogAuthors.id, created.id));
    expect(before?.slug).toMatch(/^priya-nair-/);

    await saveAuthor(db(), admin, author({ authorId: created.id, name: "Priya N. Nair" }));
    const [after] = await db().select({ slug: blogAuthors.slug, name: blogAuthors.name }).from(blogAuthors).where(eq(blogAuthors.id, created.id));
    // The public URL /blogs/author/<slug> must survive an editorial rename.
    expect(after?.slug).toBe(before?.slug);
    expect(after?.name).toBe("Priya N. Nair");
  });

  it("rejects a slug that would shadow a reserved journal route", async () => {
    await expectServiceError(saveAuthor(db(), admin, author({ slug: "search" })), 422, "invalid_slug");
    await expectServiceError(saveCategory(db(), admin, category({ slug: "archive" })), 422, "invalid_slug");
  });

  it("reports a duplicate slug as a conflict rather than a crash", async () => {
    const slug = `dup-${Date.now().toString(36)}`;
    await saveCategory(db(), admin, category({ name: `Delivery ${slug}`, slug }));
    await expectServiceError(saveCategory(db(), admin, category({ name: `Growth ${slug}`, slug })), 409, "duplicate");
  });

  it("refuses to archive an author or category a published post still uses, then allows it once withdrawn", async () => {
    const a = await makeAuthor();
    const c = await makeCategory();
    const { postId } = await createPost(db(), admin);
    await saveDraft(db(), admin, {
      postId, expectedVersion: 1, title: "A weekly operating review", slug: `taxonomy-live-${Date.now().toString(36)}`,
      excerpt: "A one-page weekly review a small team can act on the same day.", standfirst: null, doc: longDoc(),
      seoTitle: null, seoDescription: null, coverMediaId: cover, coverAlt: "A planning board", coverCaption: null,
      socialMediaId: null, authorId: a.id, categoryId: c.id, tags: [], isFeatured: false, ctaKey: "pricing",
    });
    await publishNow(db(), admin, postId, 2);

    await expectServiceError(archiveAuthor(db(), admin, a.id, true), 409, "in_use");
    await expectServiceError(archiveCategory(db(), admin, c.id, true), 409, "in_use");

    // Withdrawing the post releases both; neither entity is ever hard-deleted, so the revision
    // that credits them keeps its attribution.
    await db().update(blogPosts).set({ status: "archived" }).where(eq(blogPosts.id, postId));
    await archiveAuthor(db(), admin, a.id, true);
    await archiveCategory(db(), admin, c.id, true);
    const [archivedAuthor] = await db().select({ archivedAt: blogAuthors.archivedAt }).from(blogAuthors).where(eq(blogAuthors.id, a.id));
    const [archivedCategory] = await db().select({ archivedAt: blogCategories.archivedAt }).from(blogCategories).where(eq(blogCategories.id, c.id));
    expect(archivedAuthor?.archivedAt).toBeInstanceOf(Date);
    expect(archivedCategory?.archivedAt).toBeInstanceOf(Date);

    await archiveAuthor(db(), admin, a.id, false);
    const [restored] = await db().select({ archivedAt: blogAuthors.archivedAt }).from(blogAuthors).where(eq(blogAuthors.id, a.id));
    expect(restored?.archivedAt).toBeNull();
  });

  it("counts only live posts in the management lists", async () => {
    const a = await makeAuthor();
    const c = await makeCategory();
    const { postId } = await createPost(db(), admin);
    await saveDraft(db(), admin, {
      postId, expectedVersion: 1, title: "A draft that should not count", slug: `taxonomy-draft-${Date.now().toString(36)}`,
      excerpt: "Drafts never appear in the public counts an editor sees beside an author.", standfirst: null, doc: longDoc(),
      seoTitle: null, seoDescription: null, coverMediaId: cover, coverAlt: "A planning board", coverCaption: null,
      socialMediaId: null, authorId: a.id, categoryId: c.id, tags: [], isFeatured: false, ctaKey: "pricing",
    });

    expect((await listAuthors(db())).find((row) => row.id === a.id)?.livePosts).toBe(0);
    expect((await listCategories(db())).find((row) => row.id === c.id)?.livePosts).toBe(0);

    await publishNow(db(), admin, postId, 2);
    const [row] = await db().select({ status: blogPosts.status, authorId: blogPosts.authorId, categoryId: blogPosts.categoryId, deletedAt: blogPosts.deletedAt }).from(blogPosts).where(eq(blogPosts.id, postId));
    expect(row).toEqual({ status: "published", authorId: a.id, categoryId: c.id, deletedAt: null });
    expect((await listAuthors(db())).find((row) => row.id === a.id)?.livePosts).toBe(1);
    expect((await listCategories(db())).find((row) => row.id === c.id)?.livePosts).toBe(1);
  });

  it("rejects a profile link given as a URL instead of a handle", async () => {
    const parsed = (await import("@/lib/server/blog/taxonomy")).authorInputSchema.safeParse(
      author({ twitter: "https://twitter.com/priya" }),
    );
    expect(parsed.success).toBe(false);
  });
});
