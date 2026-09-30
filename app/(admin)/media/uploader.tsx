"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { waitForMedia } from "@/components/media/media-picker";
import { UploadError, uploadImageFile } from "@/components/media/upload";

export function Uploader() {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="min-h-11 cursor-pointer rounded-md bg-ink px-4 py-2.5 text-sm font-medium text-paper focus-within:outline focus-within:outline-3 focus-within:outline-accent">
        Upload images
        <input type="file" multiple accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          setError(null);
          for (const [i, file] of files.entries()) {
            try {
              setStatus(`Uploading ${i + 1} of ${files.length}: ${file.name}`);
              const id = await uploadImageFile(file);
              setStatus(`Processing ${file.name}…`);
              await waitForMedia(id, 10);
            } catch (err) {
              setError(`${file.name}: ${err instanceof UploadError ? err.message : "upload failed"}`);
            }
          }
          setStatus(null);
          router.refresh();
        }} />
      </label>
      <span aria-live="polite" className="text-sm text-muted">{status}</span>
      {error ? <span role="alert" className="text-sm text-danger">{error}</span> : null}
    </div>
  );
}
