import "server-only";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { env } from "../env";

const globalForR2 = globalThis as unknown as { blogAdminR2?: S3Client };

/**
 * One client for both editorial buckets, using the S3 API endpoint (presigned URLs are only valid
 * there, never on the public media domain). Credentials are scoped to the two blog buckets and
 * never leave the server.
 */
export function r2(): S3Client {
  if (globalForR2.blogAdminR2) return globalForR2.blogAdminR2;
  const e = env();
  globalForR2.blogAdminR2 = new S3Client({
    region: "auto",
    endpoint: e.R2_ENDPOINT,
    forcePathStyle: e.R2_FORCE_PATH_STYLE,
    credentials: { accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY },
    requestHandler: { requestTimeout: 30_000, connectionTimeout: 5_000 },
    // The SDK's default flexible checksums add headers a browser PUT to a presigned URL cannot
    // reproduce, and R2 does not need them; compute checksums only where an operation requires one.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return globalForR2.blogAdminR2;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof S3ServiceException && (error.$metadata.httpStatusCode === 404 || error.name === "NotFound" || error.name === "NoSuchKey");
}

export async function headObject(bucket: string, key: string): Promise<{ size: number; contentType: string | null } | null> {
  try {
    const res = await r2().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Reads an object fully, refusing anything over `maxBytes` rather than buffering it. */
export async function getObjectBytes(bucket: string, key: string, maxBytes: number): Promise<Buffer> {
  const res = await r2().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if ((res.ContentLength ?? 0) > maxBytes) throw new Error("object exceeds the size limit");
  const bytes = await res.Body?.transformToByteArray();
  if (!bytes) throw new Error("object has no body");
  if (bytes.byteLength > maxBytes) throw new Error("object exceeds the size limit");
  return Buffer.from(bytes);
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  try {
    await r2().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}
