import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { blogPosts } from "../db/schema";
import { env } from "../env";
import { signBlogEvent } from "./sign";

export const notifyPayloadSchema = z.object({
  eventId: z.string().uuid(),
  postId: z.string().uuid(),
  generation: z.number().int().min(0),
  reason: z.enum(["publish", "update", "rename", "unpublish", "delete"]),
  revisionId: z.string().uuid().nullable(),
  slug: z.string().min(1).max(256),
});

const ackSchema = z.object({
  success: z.literal(true),
  data: z.object({ acknowledged: z.literal(true), duplicate: z.boolean(), publishedRevisionId: z.string().uuid().nullable() }),
});

export const REVISION_META = "streamline:revision";

/**
 * Delivers the signed notification to the existing backend, then proves the result on the public
 * site: a published revision must be served in the article's HTML, a withdrawn article must be
 * gone. Any shortfall throws, so the job retries with backoff and stays visible until it holds.
 * A notification made obsolete by a later publication is skipped — that one verifies instead.
 */
export async function deliverNotify(database: Db, raw: unknown): Promise<"live" | "withdrawn" | "superseded"> {
  const payload = notifyPayloadSchema.parse(raw);
  const [post] = await database
    .select({ status: blogPosts.status, publishedRevisionId: blogPosts.publishedRevisionId, deletedAt: blogPosts.deletedAt })
    .from(blogPosts).where(eq(blogPosts.id, payload.postId));
  const live = post?.status === "published" && !post.deletedAt;
  if (payload.revisionId ? !live || post?.publishedRevisionId !== payload.revisionId : live) return "superseded";

  const e = env();
  const body = JSON.stringify({ eventId: payload.eventId, postId: payload.postId, generation: payload.generation, reason: payload.reason });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await fetch(e.BLOG_INVALIDATION_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-blog-event-id": payload.eventId,
      "x-blog-timestamp": timestamp,
      "x-blog-signature": signBlogEvent(e.BLOG_INVALIDATION_SECRET, timestamp, payload.eventId, body),
    },
    body,
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Backend refused the notification (HTTP ${res.status})`);
  const ack = ackSchema.parse(await res.json());
  if (ack.data.publishedRevisionId !== payload.revisionId) {
    throw new Error(payload.revisionId ? "Backend does not serve the new revision yet" : "Backend still serves the withdrawn article");
  }

  const page = await fetch(`${e.PUBLIC_SITE_ORIGIN}/blogs/${encodeURIComponent(payload.slug)}`, {
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
    headers: { "user-agent": "StreamlineOS-BlogAdmin-Verifier/1.0" },
  });
  if (payload.revisionId) {
    const html = page.status === 200 ? await page.text() : "";
    if (!html.includes(`<meta name="${REVISION_META}" content="${payload.revisionId}"`)) {
      throw new Error(`Public article does not show the new revision yet (HTTP ${page.status})`);
    }
    return "live";
  }
  if (page.status !== 404 && page.status !== 410) throw new Error(`Public article still answers HTTP ${page.status}`);
  return "withdrawn";
}
