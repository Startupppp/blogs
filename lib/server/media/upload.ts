import "server-only";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit";
import { assertCan, type Editor } from "../auth/editor";
import type { Db } from "../db/client";
import { blogMedia, type MediaVariant } from "../db/schema";
import { env } from "../env";
import { ServiceError, notFound } from "../errors";
import { enqueue } from "../jobs/queue";
import { consumeRateLimit } from "../rate-limit";
import { encodeVariants, inspectImage, sha256 } from "./process";
import { deleteObject, getObjectBytes, headObject, r2 } from "./r2";
import { EXTENSION, MAX_UPLOAD_BYTES, isAcceptedMime, sniffImageMime } from "./sniff";

export const UPLOAD_URL_TTL_SECS = 300;

export const uploadIntentSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  size: z.number().int().min(1),
  mime: z.string().max(64),
}).strict();

export type UploadIntentInput = z.infer<typeof uploadIntentSchema>;

/**
 * Step 1: a short-lived presigned PUT for ONE random key in the private pending area, bound to the
 * declared content type. The browser never chooses a key or a bucket, and nothing it uploads is
 * trusted until finalize has re-read and verified the bytes.
 */
export async function createUploadIntent(database: Db, editor: Editor, input: UploadIntentInput) {
  assertCan(editor, "media:upload");
  if (!isAcceptedMime(input.mime)) throw new ServiceError(422, "unsupported_type", "Upload a JPEG, PNG or WebP image.", { file: "Upload a JPEG, PNG or WebP image." });
  if (input.size > MAX_UPLOAD_BYTES) throw new ServiceError(413, "too_large", "Images must be 10 MB or smaller.", { file: "Images must be 10 MB or smaller." });
  await consumeRateLimit(`upload-intent:${editor.id}`, 30, 600);

  const id = crypto.randomUUID();
  const key = `pending/${id}/${crypto.randomUUID()}`;
  await database.insert(blogMedia).values({
    id,
    privateKey: key,
    status: "pending",
    fileName: input.fileName.replace(/[^\w.\- ]+/g, "_"),
    declaredMime: input.mime,
    declaredBytes: input.size,
    variants: [],
    focalX: 0.5,
    focalY: 0.5,
    createdBy: editor.id,
  });
  const uploadUrl = await getSignedUrl(
    r2(),
    new PutObjectCommand({ Bucket: env().R2_PRIVATE_BUCKET, Key: key, ContentType: input.mime }),
    { expiresIn: UPLOAD_URL_TTL_SECS },
  );
  return { mediaId: id, uploadUrl, headers: { "Content-Type": input.mime }, expiresInSeconds: UPLOAD_URL_TTL_SECS };
}

async function failMedia(database: Db, mediaId: string, reason: string) {
  await database.update(blogMedia).set({ status: "failed", failureReason: reason.slice(0, 300), updatedAt: new Date() }).where(eq(blogMedia.id, mediaId));
}

/**
 * Step 2: verifies what actually arrived — size, signature-derived type, a full decode, animation
 * and pixel limits — then copies exactly those verified bytes to an immutable key named by their
 * SHA-256. The pending key (which the presigned URL could still overwrite) is never used again.
 */
export async function finalizeUpload(database: Db, editor: Editor, mediaId: string) {
  assertCan(editor, "media:upload");
  const [media] = await database.select().from(blogMedia).where(eq(blogMedia.id, mediaId));
  if (!media || (media.createdBy !== editor.id && editor.role === "writer")) throw notFound("Upload");
  if (media.status !== "pending") return { mediaId, status: media.status, processKey: null };

  const bucket = env().R2_PRIVATE_BUCKET;
  const head = await headObject(bucket, media.privateKey);
  if (!head) throw new ServiceError(409, "upload_missing", "The upload did not arrive. Upload the file again.");
  if (head.size > MAX_UPLOAD_BYTES) {
    await deleteObject(bucket, media.privateKey);
    await failMedia(database, mediaId, "File is larger than 10 MB.");
    throw new ServiceError(413, "too_large", "Images must be 10 MB or smaller.");
  }

  const bytes = await getObjectBytes(bucket, media.privateKey, MAX_UPLOAD_BYTES);
  const mime = sniffImageMime(bytes);
  if (!mime) {
    await deleteObject(bucket, media.privateKey);
    await failMedia(database, mediaId, "The file is not a JPEG, PNG or WebP image.");
    throw new ServiceError(422, "unsupported_type", "The file is not a JPEG, PNG or WebP image.");
  }
  let info: Awaited<ReturnType<typeof inspectImage>>;
  try {
    info = await inspectImage(bytes);
  } catch (error) {
    await deleteObject(bucket, media.privateKey);
    const reason = error instanceof Error && /Animated|megapixels|dimensions/.test(error.message) ? error.message : "The image could not be decoded.";
    await failMedia(database, mediaId, reason);
    throw new ServiceError(422, "invalid_image", reason);
  }

  const checksum = sha256(bytes);
  const originalKey = `originals/${mediaId}/${checksum}.${EXTENSION[mime]}`;
  await r2().send(new PutObjectCommand({ Bucket: bucket, Key: originalKey, Body: bytes, ContentType: mime }));
  await deleteObject(bucket, media.privateKey);

  await database.transaction(async (tx) => {
    await tx.update(blogMedia).set({
      status: "processing",
      privateKey: originalKey,
      mime,
      byteSize: bytes.byteLength,
      checksumSha256: checksum,
      width: info.width,
      height: info.height,
      updatedAt: new Date(),
    }).where(and(eq(blogMedia.id, mediaId), eq(blogMedia.status, "pending")));
    await enqueue(tx, "media.process", { mediaId, checksum }, { dedupeKey: `process:${mediaId}:${checksum}`, maxAttempts: 5 });
    await audit(tx, { actorId: editor.id, action: "media.upload", mediaId, summary: `${mime} ${info.width}x${info.height}` });
  });
  return { mediaId, status: "processing" as const, processKey: `process:${mediaId}:${checksum}` };
}

/**
 * The processing job: re-reads the immutable original, checks it is byte-for-byte what finalize
 * verified, and writes the variants privately. Nothing becomes public here; publishing promotes.
 */
export async function processMedia(database: Db, payload: { mediaId: string; checksum: string }): Promise<"ready" | "skipped"> {
  const [media] = await database.select().from(blogMedia).where(eq(blogMedia.id, payload.mediaId));
  if (!media || media.status !== "processing" || media.checksumSha256 !== payload.checksum) return "skipped";
  const bucket = env().R2_PRIVATE_BUCKET;
  const bytes = await getObjectBytes(bucket, media.privateKey, MAX_UPLOAD_BYTES);
  if (sha256(bytes) !== payload.checksum) {
    await failMedia(database, media.id, "The stored original does not match the verified upload.");
    return "skipped";
  }
  let encoded: Awaited<ReturnType<typeof encodeVariants>>;
  try {
    encoded = await encodeVariants(bytes, { x: media.focalX, y: media.focalY });
  } catch {
    await failMedia(database, media.id, "The image could not be processed.");
    return "skipped";
  }
  const variants: MediaVariant[] = [];
  for (const v of encoded) {
    const ext = v.format === "webp" ? "webp" : "jpg";
    const privateKey = `variants/${media.id}/${v.checksum}.${ext}`;
    await r2().send(new PutObjectCommand({ Bucket: bucket, Key: privateKey, Body: v.data, ContentType: v.mime }));
    const { data: _data, ...meta } = v;
    // Per-media, content-addressed: immutable and cacheable forever, and removing one image's public
    // copies can never delete an identical file another image also serves.
    variants.push({ ...meta, privateKey, publicKey: `blog/${media.id}/${v.checksum}.${ext}` });
  }
  await database.update(blogMedia).set({ status: "ready", variants, failureReason: null, updatedAt: new Date() })
    .where(and(eq(blogMedia.id, media.id), eq(blogMedia.status, "processing")));
  return "ready";
}
