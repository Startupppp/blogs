import "server-only";
import { and, count, desc, eq, ilike, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit";
import { assertCan, type Editor } from "../auth/editor";
import type { Db } from "../db/client";
import { blogMedia, blogRevisionMedia } from "../db/schema";
import { env } from "../env";
import { ServiceError, notFound } from "../errors";
import { enqueue } from "../jobs/queue";
import { mediaInLiveUse } from "../blog/publish";
import { unpromoteMedia } from "./promote";
import { deleteObject } from "./r2";

const PAGE_SIZE = 48;

export const mediaMetaSchema = z.object({
  mediaId: z.string().uuid(),
  altDefault: z.string().trim().max(300).nullable(),
  credit: z.string().trim().max(300).nullable(),
  sourceUrl: z.string().trim().url().max(1000).refine((v) => /^https?:/i.test(v), "Use an http(s) link").nullable(),
  license: z.string().trim().max(300).nullable(),
  focalX: z.number().min(0).max(1),
  focalY: z.number().min(0).max(1),
}).strict();

export async function listMedia(database: Db, editor: Editor, opts: { q?: string; page: number }) {
  assertCan(editor, "media:upload");
  const where = and(
    ne(blogMedia.status, "deleted"),
    opts.q ? or(ilike(blogMedia.fileName, `${opts.q.replace(/[%_\\]/g, "\\$&")}%`), ilike(blogMedia.altDefault, `${opts.q.replace(/[%_\\]/g, "\\$&")}%`)) : undefined,
  );
  const [rows, [total]] = await Promise.all([
    database.select().from(blogMedia).where(where).orderBy(desc(blogMedia.createdAt), desc(blogMedia.id)).limit(PAGE_SIZE).offset((opts.page - 1) * PAGE_SIZE),
    database.select({ value: count() }).from(blogMedia).where(where),
  ]);
  return { items: rows, total: total?.value ?? 0, pageSize: PAGE_SIZE };
}

export async function updateMediaMeta(database: Db, editor: Editor, input: z.infer<typeof mediaMetaSchema>) {
  assertCan(editor, "media:upload");
  const [media] = await database.select().from(blogMedia).where(eq(blogMedia.id, input.mediaId));
  if (!media || media.status === "deleted") throw notFound("Image");
  if (editor.role === "writer" && media.createdBy !== editor.id) throw new ServiceError(404, "not_found", "Image not found");
  const focalChanged = Math.abs(media.focalX - input.focalX) > 0.001 || Math.abs(media.focalY - input.focalY) > 0.001;
  if (focalChanged && media.promotedAt) {
    throw new ServiceError(409, "media_published", "This image is already public; upload a new copy to change its crop.", { focal: "Crop is locked once published." });
  }
  await database.transaction(async (tx) => {
    await tx.update(blogMedia).set({
      altDefault: input.altDefault,
      credit: input.credit,
      sourceUrl: input.sourceUrl,
      license: input.license,
      focalX: input.focalX,
      focalY: input.focalY,
      ...(focalChanged && media.status === "ready" ? { status: "processing" as const } : {}),
      updatedAt: new Date(),
    }).where(eq(blogMedia.id, media.id));
    if (focalChanged && media.status === "ready" && media.checksumSha256) {
      await enqueue(tx, "media.process", { mediaId: media.id, checksum: media.checksumSha256 }, { dedupeKey: `process:${media.id}:${media.checksumSha256}:${Date.now()}`, maxAttempts: 5 });
    }
    await audit(tx, { actorId: editor.id, action: "media.update", mediaId: media.id });
  });
}

/** Deletes an image nobody references. A referenced image is refused, never silently removed. */
export async function deleteMedia(database: Db, editor: Editor, mediaId: string) {
  const [media] = await database.select().from(blogMedia).where(eq(blogMedia.id, mediaId));
  if (!media || media.status === "deleted") throw notFound("Image");
  if (editor.role === "writer") {
    if (media.createdBy !== editor.id) throw notFound("Image");
  } else assertCan(editor, "media:manage");
  const [refs] = await database.select({ value: count() }).from(blogRevisionMedia).where(eq(blogRevisionMedia.mediaId, mediaId));
  if ((refs?.value ?? 0) > 0) {
    throw new ServiceError(409, "media_in_use", `This image is used in ${refs?.value} post revision(s). Remove it from those posts first.`);
  }
  await removeObjects(database, media);
  await database.update(blogMedia).set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() }).where(eq(blogMedia.id, mediaId));
  await audit(database, { actorId: editor.id, action: "media.delete", mediaId });
}

/** Explicit removal from public delivery for an image no live post uses. */
export async function removeFromDelivery(database: Db, editor: Editor, mediaId: string) {
  assertCan(editor, "media:manage");
  if (await mediaInLiveUse(database, mediaId)) {
    throw new ServiceError(409, "media_in_use", "A published or scheduled post still uses this image.");
  }
  await unpromoteMedia(database, mediaId);
  await audit(database, { actorId: editor.id, action: "media.unpublish", mediaId, summary: "Public copies removed; purge the CDN if it must vanish at once." });
}

async function removeObjects(database: Db, media: typeof blogMedia.$inferSelect) {
  const e = env();
  await deleteObject(e.R2_PRIVATE_BUCKET, media.privateKey);
  for (const v of media.variants) await deleteObject(e.R2_PRIVATE_BUCKET, v.privateKey);
  if (media.promotedAt) await unpromoteMedia(database, media.id);
}

/**
 * Durable cleanup, run by the job runner each tick in bounded batches:
 *  - uploads never finalized within a day are removed;
 *  - failed images older than a week, referenced by nothing, are removed;
 *  - public copies of images referenced by no revision at all (a publish whose transaction failed
 *    after promotion) are withdrawn after a day's grace.
 */
export async function sweepMedia(database: Db, batch = 25): Promise<number> {
  let handled = 0;
  const abandoned = await database.select().from(blogMedia)
    .where(and(eq(blogMedia.status, "pending"), lt(blogMedia.createdAt, sql`now() - interval '1 day'`))).limit(batch);
  const failed = await database.select().from(blogMedia)
    .where(and(eq(blogMedia.status, "failed"), lt(blogMedia.updatedAt, sql`now() - interval '7 days'`),
      sql`NOT EXISTS (SELECT 1 FROM blog_revision_media rm WHERE rm.media_id = ${blogMedia.id})`)).limit(batch);
  for (const media of [...abandoned, ...failed]) {
    await removeObjects(database, media);
    await database.update(blogMedia).set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() }).where(eq(blogMedia.id, media.id));
    await audit(database, { actorId: null, action: "media.cleanup", mediaId: media.id, summary: media.status });
    handled++;
  }
  const orphans = await database.select({ id: blogMedia.id }).from(blogMedia)
    .where(and(isNotNull(blogMedia.promotedAt), lt(blogMedia.promotedAt, sql`now() - interval '1 day'`),
      sql`NOT EXISTS (SELECT 1 FROM blog_revision_media rm WHERE rm.media_id = ${blogMedia.id})`)).limit(batch);
  for (const orphan of orphans) {
    await unpromoteMedia(database, orphan.id);
    await audit(database, { actorId: null, action: "media.orphan_unpublish", mediaId: orphan.id });
    handled++;
  }
  return handled;
}
