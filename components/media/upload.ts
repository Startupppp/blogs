"use client";

import { ACCEPTED_MIME, MAX_UPLOAD_BYTES } from "@/lib/server/media/sniff";

export class UploadError extends Error {}

/**
 * Browser half of the upload: ask for an intent, PUT the bytes straight to R2 with the presigned
 * URL, then ask the server to verify and process them. The browser never names a key or bucket.
 * An expired URL just means asking for a new intent; the editor's content is untouched either way.
 */
export async function uploadImageFile(file: File, onStage?: (stage: "requesting" | "uploading" | "verifying") => void): Promise<string> {
  if (!(ACCEPTED_MIME as readonly string[]).includes(file.type)) throw new UploadError("Upload a JPEG, PNG or WebP image.");
  if (file.size > MAX_UPLOAD_BYTES) throw new UploadError("Images must be 10 MB or smaller.");
  onStage?.("requesting");
  const intentRes = await fetch("/api/media/upload-intent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileName: file.name, size: file.size, mime: file.type }),
  });
  const intent = await intentRes.json().catch(() => null);
  if (!intentRes.ok || !intent?.uploadUrl) throw new UploadError(intent?.message ?? "Could not start the upload.");

  onStage?.("uploading");
  const put = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.headers, body: file });
  if (!put.ok) throw new UploadError(put.status === 403 ? "The upload link expired. Try again." : "The upload failed. Try again.");

  onStage?.("verifying");
  const finalize = await fetch("/api/media/finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mediaId: intent.mediaId }),
  });
  const done = await finalize.json().catch(() => null);
  if (!finalize.ok) throw new UploadError(done?.message ?? "The image could not be verified.");
  return intent.mediaId as string;
}
