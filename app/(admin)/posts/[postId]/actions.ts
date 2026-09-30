"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { editorAction } from "@/lib/server/action";
import { assertCanEditPost } from "@/lib/server/auth/editor";
import { draftInputSchema, versionedPostSchema } from "@/lib/server/blog/inputs";
import { checkpoint, restoreRevision, saveDraft } from "@/lib/server/blog/posts";
import { checkPublishable } from "@/lib/server/blog/publish-checks";
import { cancelSchedule, deletePost, publishNow, restoreArchived, schedulePost, unpublishPost } from "@/lib/server/blog/publish";
import { reassignOwner } from "@/lib/server/blog/queries";
import { db } from "@/lib/server/db/client";
import { blogPostRevisions, blogPosts } from "@/lib/server/db/schema";
import { notFound } from "@/lib/server/errors";
import { retryDeadJob } from "@/lib/server/jobs/queue";
import { publicationState, runJobNow, runJobs } from "@/lib/server/jobs/runner";
import { consumeRateLimit } from "@/lib/server/rate-limit";

const uuid = z.string().uuid();

/** Bounded wait for the website to confirm; past it the queue keeps going and the UI keeps polling. */
const CONFIRM_BUDGET_MS = 8_000;

export async function saveDraftAction(input: unknown) {
  return editorAction(null, async (editor) => {
    await consumeRateLimit(`save:${editor.id}`, 240, 60);
    return saveDraft(db(), editor, draftInputSchema.parse(input));
  });
}

export async function publishCheckAction(postId: unknown) {
  return editorAction("post:publish", async () => {
    const id = uuid.parse(postId);
    const [post] = await db().select().from(blogPosts).where(eq(blogPosts.id, id));
    if (!post || post.deletedAt || !post.workingRevisionId) throw notFound("Post");
    const [rev] = await db().select().from(blogPostRevisions).where(eq(blogPostRevisions.id, post.workingRevisionId));
    if (!rev) throw notFound("Revision");
    const { errors, warnings } = await checkPublishable(db(), post, rev);
    return { errors, warnings };
  });
}

export async function publishAction(input: unknown) {
  return editorAction("post:publish", async (editor) => {
    await consumeRateLimit(`publish:${editor.id}`, 30, 60);
    const { postId, expectedVersion } = versionedPostSchema.parse(input);
    const outcome = await publishNow(db(), editor, postId, expectedVersion);
    await runJobNow(db(), outcome.notifyKey, CONFIRM_BUDGET_MS).catch(() => null);
    return { ...outcome, publication: await publicationState(db(), postId) };
  });
}

export async function scheduleAction(input: unknown) {
  return editorAction("post:publish", async (editor) => {
    const { postId, expectedVersion, when } = versionedPostSchema.extend({ when: z.string().datetime() }).parse(input);
    return schedulePost(db(), editor, postId, expectedVersion, when);
  });
}

export async function cancelScheduleAction(input: unknown) {
  return editorAction("post:publish", async (editor) => {
    const { postId, expectedVersion } = versionedPostSchema.parse(input);
    return cancelSchedule(db(), editor, postId, expectedVersion);
  });
}

export async function unpublishAction(input: unknown) {
  return editorAction("post:publish", async (editor) => {
    const { postId, expectedVersion } = versionedPostSchema.parse(input);
    const result = await unpublishPost(db(), editor, postId, expectedVersion);
    await runJobNow(db(), result.notifyKey, CONFIRM_BUDGET_MS).catch(() => null);
    return { version: result.version, publication: await publicationState(db(), postId) };
  });
}

export async function restoreArchivedAction(input: unknown) {
  return editorAction("post:publish", async (editor) => {
    const { postId, expectedVersion } = versionedPostSchema.parse(input);
    return restoreArchived(db(), editor, postId, expectedVersion);
  });
}

export async function deletePostAction(input: unknown) {
  const result = await editorAction("post:publish", async (editor) => {
    const { postId, expectedVersion } = versionedPostSchema.parse(input);
    const deleted = await deletePost(db(), editor, postId, expectedVersion);
    if (deleted.notifyKey) await runJobNow(db(), deleted.notifyKey, CONFIRM_BUDGET_MS).catch(() => null);
    return deleted;
  });
  if (result.ok) redirect("/posts");
  return result;
}

export async function checkpointAction(input: unknown) {
  return editorAction(null, async (editor) => {
    const { postId, expectedVersion, summary } = versionedPostSchema.extend({ summary: z.string().trim().max(500) }).parse(input);
    return checkpoint(db(), editor, postId, expectedVersion, summary);
  });
}

export async function restoreRevisionAction(input: unknown) {
  return editorAction(null, async (editor) => {
    const { postId, expectedVersion, revisionId } = versionedPostSchema.extend({ revisionId: uuid }).parse(input);
    return restoreRevision(db(), editor, postId, revisionId, expectedVersion);
  });
}

export async function reassignAction(input: unknown) {
  return editorAction("post:reassign", async (editor) => {
    const { postId, expectedVersion, ownerEditorId } = versionedPostSchema.extend({ ownerEditorId: uuid }).parse(input);
    return reassignOwner(db(), editor, postId, ownerEditorId, expectedVersion);
  });
}

export async function publicationStateAction(postId: unknown) {
  return editorAction(null, async (editor) => {
    const id = uuid.parse(postId);
    const [post] = await db().select({ ownerEditorId: blogPosts.ownerEditorId }).from(blogPosts).where(eq(blogPosts.id, id));
    if (!post) throw notFound("Post");
    assertCanEditPost(editor, post);
    return publicationState(db(), id);
  });
}

export async function retryNotifyAction(input: unknown) {
  return editorAction("post:publish", async () => {
    const { postId, jobId } = z.object({ postId: uuid, jobId: uuid }).strict().parse(input);
    await retryDeadJob(db(), jobId, postId);
    await runJobs(db(), { onlyIds: [jobId], budgetMs: CONFIRM_BUDGET_MS, maxJobs: 1 }).catch(() => null);
    return publicationState(db(), postId);
  });
}
