import "server-only";
import { CopyObjectCommand } from "@aws-sdk/client-s3";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { blogMedia } from "../db/schema";
import { env } from "../env";
import { ServiceError } from "../errors";
import { deleteObject, headObject, r2 } from "./r2";

/** Immutable, content-addressed public objects: a replaced image always gets new keys. */
export const PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Copies every variant of ready media into the public delivery bucket, then confirms each copy is
 * there. Idempotent: an object already present is left alone. Only verified, processed variants are
 * ever copied — never an upload key and never an original.
 */
export async function promoteMedia(database: Db, mediaIds: string[]): Promise<void> {
  if (mediaIds.length === 0) return;
  const e = env();
  const rows = await database.select().from(blogMedia).where(inArray(blogMedia.id, mediaIds));
  for (const media of rows) {
    if (media.status !== "ready" || media.variants.length === 0) {
      throw new ServiceError(409, "media_not_ready", "An image is not ready to publish.", { media: media.id });
    }
    for (const v of media.variants) {
      if (await headObject(e.R2_PUBLIC_BUCKET, v.publicKey)) continue;
      await r2().send(new CopyObjectCommand({
        Bucket: e.R2_PUBLIC_BUCKET,
        Key: v.publicKey,
        CopySource: `${e.R2_PRIVATE_BUCKET}/${v.privateKey}`,
        ContentType: v.mime,
        CacheControl: PUBLIC_CACHE_CONTROL,
        MetadataDirective: "REPLACE",
      }));
      const copied = await headObject(e.R2_PUBLIC_BUCKET, v.publicKey);
      if (!copied || copied.size !== v.bytes) throw new ServiceError(503, "promotion_failed", "An image could not be made public. Try again.");
    }
    if (!media.promotedAt) {
      await database.update(blogMedia).set({ promotedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(blogMedia.id, media.id), isNull(blogMedia.promotedAt)));
    }
  }
}

/**
 * Removes an image's public copies. Callers must first establish that no published or scheduled
 * revision uses it. CDN caches may still hold copies until they expire or are purged, and copies
 * already downloaded by others cannot be recalled.
 */
export async function unpromoteMedia(database: Db, mediaId: string): Promise<void> {
  const e = env();
  const [media] = await database.select().from(blogMedia).where(eq(blogMedia.id, mediaId));
  if (!media) return;
  for (const v of media.variants) await deleteObject(e.R2_PUBLIC_BUCKET, v.publicKey);
  await database.update(blogMedia).set({ promotedAt: null, updatedAt: new Date() }).where(eq(blogMedia.id, mediaId));
}
