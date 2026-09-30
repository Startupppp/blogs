import { eq } from "drizzle-orm";
import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/server/db/client";
import { blogJobs, blogPosts, blogRedirects } from "@/lib/server/db/schema";
import { AuthError, type Editor } from "@/lib/server/auth/editor";
import { ServiceError } from "@/lib/server/errors";
import { createPost, listRevisions, restoreRevision, saveDraft } from "@/lib/server/blog/posts";
import { cancelSchedule, deletePost, publishNow, restoreArchived, schedulePost, unpublishPost } from "@/lib/server/blog/publish";
import { publicationState, runJobNow, runJobs } from "@/lib/server/jobs/runner";
import { longDoc, makeAuthor, makeCategory, makeEditor, testJpeg, uploadImage } from "./fixtures";

async function expectServiceError(p: Promise<unknown>, status: number, code?: string) {
  const error = await p.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).status).toBe(status);
  if (code) expect((error as ServiceError).code).toBe(code);
  return error as ServiceError;
}

let publisher: Editor;
let writer: Editor;
let author: Awaited<ReturnType<typeof makeAuthor>>;
let category: Awaited<ReturnType<typeof makeCategory>>;
let cover: string;

beforeAll(async () => {
  author = await makeAuthor();
  category = await makeCategory();
  publisher = await makeEditor("publisher", { authorId: author.id });
  writer = await makeEditor("writer", { authorId: author.id });
  cover = await uploadImage(publisher, await testJpeg());
});

async function readyDraft(editor: Editor, slug: string, overrides: Record<string, unknown> = {}) {
  const { postId } = await createPost(db(), editor);
  const saved = await saveDraft(db(), editor, {
    postId, expectedVersion: 1, title: `An onboarding checklist ${slug}`, slug, excerpt: "A practical, accountable onboarding process for growing teams.",
    standfirst: null, doc: longDoc(), seoTitle: null, seoDescription: null, coverMediaId: cover, coverAlt: "A team planning board",
    coverCaption: null, socialMediaId: null, authorId: author.id, categoryId: category.id, tags: ["People Ops"], isFeatured: false, ctaKey: "pricing",
    ...overrides,
  });
  return { postId, version: saved.version };
}

async function projection(postId: string) {
  const [row] = await db().select().from(blogPosts).where(eq(blogPosts.id, postId));
  if (!row) throw new Error("post missing");
  return row;
}

describe("least privilege", () => {
  it("the editorial role reads blog tables but not the platform's private tables", async () => {
    const sql = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
    try {
      await expect(sql`SELECT count(*) FROM blog_posts`).resolves.toBeDefined();
      await expect(sql`SELECT salary FROM hr_people`).rejects.toMatchObject({ code: "42501" });
      await expect(sql`DELETE FROM blog_audit_events`).rejects.toMatchObject({ code: "42501" });
    } finally {
      await sql.end();
    }
  });
});

describe("drafts and concurrency", () => {
  it("lets one of two editors saving the same version win; the other gets a 409 with the server draft", async () => {
    const { postId, version } = await readyDraft(publisher, "concurrent-save");
    const base = { postId, expectedVersion: version, slug: "concurrent-save", excerpt: "x", standfirst: null, doc: longDoc(), seoTitle: null, seoDescription: null, coverMediaId: cover, coverAlt: "a", coverCaption: null, socialMediaId: null, authorId: author.id, categoryId: category.id, tags: [], isFeatured: false, ctaKey: null };
    const results = await Promise.allSettled([
      saveDraft(db(), publisher, { ...base, title: "Mine" }),
      saveDraft(db(), publisher, { ...base, title: "Theirs" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected && rejected.status === "rejected" && rejected.reason).toBeInstanceOf(ServiceError);
    const error = rejected?.status === "rejected" ? (rejected.reason as ServiceError) : null;
    expect(error?.status).toBe(409);
    expect(error?.detail).toMatchObject({ version: version + 1 });
  });

  it("a writer cannot edit another writer's draft or publish", async () => {
    const other = await makeEditor("writer");
    const { postId, version } = await readyDraft(writer, "writer-owned");
    await expect(saveDraft(db(), other, { postId, expectedVersion: version, title: "x", slug: "writer-owned", excerpt: "", standfirst: null, doc: longDoc(), seoTitle: null, seoDescription: null, coverMediaId: null, coverAlt: null, coverCaption: null, socialMediaId: null, authorId: null, categoryId: null, tags: [], isFeatured: false, ctaKey: null }))
      .rejects.toBeInstanceOf(AuthError);
    await expect(publishNow(db(), writer, postId, version)).rejects.toBeInstanceOf(AuthError);
  });

  it("refuses content outside the document allowlist", async () => {
    const { postId, version } = await readyDraft(publisher, "bad-content");
    const error = await expectServiceError(saveDraft(db(), publisher, {
      postId, expectedVersion: version, title: "t", slug: "bad-content", excerpt: "", standfirst: null,
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] },
      seoTitle: null, seoDescription: null, coverMediaId: null, coverAlt: null, coverCaption: null, socialMediaId: null, authorId: null, categoryId: null, tags: [], isFeatured: false, ctaKey: null,
    }), 422, "invalid_document");
    expect(error.fields.doc).toBeTruthy();
  });
});

describe("publication lifecycle", () => {
  it("blocks publishing with field-level reasons", async () => {
    const { postId, version } = await readyDraft(publisher, "archive", { coverAlt: null, categoryId: null, doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Too short." }] }] } });
    const error = await expectServiceError(publishNow(db(), publisher, postId, version), 422, "not_publishable");
    expect(Object.keys(error.fields).sort()).toEqual(["categoryId", "coverAlt", "doc", "slug"]);
    expect(error.fields.slug).toMatch(/reserved/);
    expect((await projection(postId)).status).toBe("draft");
  });

  it("publishes, keeps the live article unchanged by draft edits, renames with a redirect, and withdraws", async () => {
    const { postId, version } = await readyDraft(publisher, "onboarding-checklist");
    const published = await publishNow(db(), publisher, postId, version);
    let live = await projection(postId);
    expect(live.status).toBe("published");
    expect(live.content).toContain('<h2 id="why-onboarding-needs-owners">');
    expect(live.cover?.src).toMatch(/^https:\/\/media\.test\/blog\//);
    expect(live.tags).toEqual(["people-ops"]);
    const firstPublishedAt = live.publishedAt;

    await runJobNow(db(), published.notifyKey);
    expect(await publicationState(db(), postId)).toMatchObject({ state: "live" });

    // Draft edit: the public projection must not move.
    const draft = await saveDraft(db(), publisher, {
      postId, expectedVersion: published.version, title: "A changed title", slug: "onboarding-checklist-2026", excerpt: "A practical, accountable onboarding process for growing teams.",
      standfirst: null, doc: longDoc(), seoTitle: null, seoDescription: null, coverMediaId: cover, coverAlt: "A team planning board", coverCaption: null,
      socialMediaId: null, authorId: author.id, categoryId: category.id, tags: [], isFeatured: false, ctaKey: null,
    });
    live = await projection(postId);
    expect(live.title).toContain("An onboarding checklist");
    expect(live.slug).toBe("onboarding-checklist");

    // Publishing the rename keeps the first publication date and redirects the old URL.
    const renamed = await publishNow(db(), publisher, postId, draft.version);
    live = await projection(postId);
    expect(live.slug).toBe("onboarding-checklist-2026");
    expect(live.publishedAt?.getTime()).toBe(firstPublishedAt?.getTime());
    const [redirect] = await db().select().from(blogRedirects).where(eq(blogRedirects.sourcePath, "/blogs/onboarding-checklist"));
    expect(redirect).toMatchObject({ targetPath: "/blogs/onboarding-checklist-2026", statusCode: 301 });
    await runJobNow(db(), renamed.notifyKey);
    expect(await publicationState(db(), postId)).toMatchObject({ state: "live" });

    // A second rename collapses the chain: the first URL now points straight at the newest.
    const again = await saveDraft(db(), publisher, {
      postId, expectedVersion: renamed.version, title: "Final title", slug: "onboarding-checklist-final", excerpt: "A practical, accountable onboarding process for growing teams.",
      standfirst: null, doc: longDoc(), seoTitle: null, seoDescription: null, coverMediaId: cover, coverAlt: "A team planning board", coverCaption: null,
      socialMediaId: null, authorId: author.id, categoryId: category.id, tags: [], isFeatured: false, ctaKey: null,
    });
    const final = await publishNow(db(), publisher, postId, again.version);
    const chain = await db().select().from(blogRedirects).where(eq(blogRedirects.postId, postId));
    expect(chain.map((r) => [r.sourcePath, r.targetPath]).sort()).toEqual([
      ["/blogs/onboarding-checklist", "/blogs/onboarding-checklist-final"],
      ["/blogs/onboarding-checklist-2026", "/blogs/onboarding-checklist-final"],
    ]);

    const withdrawn = await unpublishPost(db(), publisher, postId, final.version);
    expect((await projection(postId)).status).toBe("archived");
    await runJobNow(db(), withdrawn.notifyKey);
    expect(await publicationState(db(), postId)).toMatchObject({ state: "withdrawn" });

    const restored = await restoreArchived(db(), publisher, postId, withdrawn.version);
    expect((await projection(postId)).status).toBe("draft");
    expect(restored.version).toBe(withdrawn.version + 1);
  });

  it("keeps a publish in the updating state until the public site really serves it", async () => {
    const { postId, version } = await readyDraft(publisher, "unreachable-article");
    const published = await publishNow(db(), publisher, postId, version);
    await runJobNow(db(), published.notifyKey);
    const state = await publicationState(db(), postId);
    expect(state).toMatchObject({ state: "updating", attempts: 1 });
    expect(state.state === "updating" && state.lastError).toMatch(/HTTP 503/);
    expect((await projection(postId)).status).toBe("published");
  });

  it("restoring an old revision creates a new working revision and publishes nothing", async () => {
    const { postId, version } = await readyDraft(publisher, "restore-me");
    const published = await publishNow(db(), publisher, postId, version);
    const { revisions } = await listRevisions(db(), publisher, postId);
    const first = revisions.at(-1);
    if (!first) throw new Error("no revision");
    const restored = await restoreRevision(db(), publisher, postId, first.id, published.version);
    const after = await projection(postId);
    expect(after.workingRevisionId).toBe(restored.revisionId);
    expect(after.publishedRevisionId).toBe(first.id);
    expect((await listRevisions(db(), publisher, postId)).revisions).toHaveLength(revisions.length + 1);
  });

  it("deleting a published post answers 410 for its URL", async () => {
    const { postId, version } = await readyDraft(publisher, "delete-me");
    const published = await publishNow(db(), publisher, postId, version);
    const deleted = await deletePost(db(), publisher, postId, published.version);
    const [gone] = await db().select().from(blogRedirects).where(eq(blogRedirects.sourcePath, "/blogs/delete-me"));
    expect(gone?.statusCode).toBe(410);
    if (!deleted.notifyKey) throw new Error("no notify");
    await runJobNow(db(), deleted.notifyKey);
    expect(await publicationState(db(), postId)).toMatchObject({ state: "withdrawn" });
  });

  it("another post cannot take a URL that redirects to an existing article", async () => {
    const { postId: other, version } = await readyDraft(publisher, "onboarding-checklist");
    const error = await expectServiceError(publishNow(db(), publisher, other, version), 422, "not_publishable");
    expect(error.fields.slug).toMatch(/already uses/);
  });
});

describe("scheduling", () => {
  it("refuses a past time with a publish-now option", async () => {
    const { postId, version } = await readyDraft(publisher, "past-time");
    const error = await expectServiceError(schedulePost(db(), publisher, postId, version, new Date(Date.now() - 60_000).toISOString()), 422, "schedule_in_past");
    expect(error.detail).toEqual({ canPublishNow: true });
  });

  it("publishes a due schedule exactly once and ignores a cancelled one", async () => {
    const a = await readyDraft(publisher, "scheduled-a");
    const scheduled = await schedulePost(db(), publisher, a.postId, a.version, new Date(Date.now() + 120_000).toISOString());
    // Later edits start a new working revision and do not change what was scheduled.
    const edited = await saveDraft(db(), publisher, {
      postId: a.postId, expectedVersion: scheduled.version, title: "Edited after scheduling", slug: "scheduled-a", excerpt: "A practical, accountable onboarding process for growing teams.",
      standfirst: null, doc: longDoc(), seoTitle: null, seoDescription: null, coverMediaId: cover, coverAlt: "A team planning board", coverCaption: null,
      socialMediaId: null, authorId: author.id, categoryId: category.id, tags: [], isFeatured: false, ctaKey: null,
    });
    const scheduledRevision = (await projection(a.postId)).scheduledRevisionId;
    expect(edited.revisionId).not.toBe(scheduledRevision);

    const b = await readyDraft(publisher, "scheduled-b");
    const bScheduled = await schedulePost(db(), publisher, b.postId, b.version, new Date(Date.now() + 120_000).toISOString());
    await cancelSchedule(db(), publisher, b.postId, bScheduled.version);

    // Make both jobs due, then run the queue twice: the second run must find nothing to publish.
    await db().update(blogJobs).set({ runAfter: new Date(Date.now() - 1000) }).where(eq(blogJobs.kind, "post.publish_scheduled"));
    await runJobs(db(), { budgetMs: 20_000 });
    await runJobs(db(), { budgetMs: 20_000 });

    const aLive = await projection(a.postId);
    expect(aLive.status).toBe("published");
    expect(aLive.publishedRevisionId).toBe(scheduledRevision);
    expect(aLive.title).toContain("An onboarding checklist");
    expect(aLive.workingRevisionId).toBe(edited.revisionId);
    expect((await projection(b.postId)).status).toBe("draft");
  });
});
