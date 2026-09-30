"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaSummary } from "@/lib/server/blog/queries";
import { getMediaAction, listMediaAction } from "@/app/(admin)/media/actions";
import { UploadError, uploadImageFile } from "./upload";

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (media: MediaSummary) => void;
  title?: string;
}

/** Waits for a just-uploaded image to finish processing, polling briefly. */
export async function waitForMedia(mediaId: string, attempts = 30): Promise<MediaSummary | null> {
  for (let i = 0; i < attempts; i++) {
    const res = await getMediaAction([mediaId]);
    const item = res.ok ? res.data[0] : undefined;
    if (item && item.status !== "processing" && item.status !== "pending") return item;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/**
 * Library picker in a native modal <dialog>: focus is trapped, Escape closes it, and focus returns
 * to the control that opened it. Upload and pick happen in one place.
 */
export function MediaPicker({ open, onClose, onSelect, title = "Choose an image" }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<MediaSummary[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (query: string) => {
    const res = await listMediaAction({ q: query, page: 1 });
    if (res.ok) setItems(res.data.items);
    else setError(res.message);
  }, []);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      void load("");
    }
    if (!open && dialog.open) dialog.close();
  }, [open, load]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const id = await uploadImageFile(file, (stage) => setStatus(stage === "uploading" ? "Uploading…" : stage === "verifying" ? "Checking and processing…" : "Preparing…"));
      setStatus("Processing…");
      const item = await waitForMedia(id);
      setStatus(null);
      if (!item) setError("The image is still processing. It will appear in the library shortly.");
      else if (item.status === "failed") setError(item.failureReason ?? "The image could not be processed.");
      else onSelect(item);
      void load(q);
    } catch (e) {
      setStatus(null);
      setError(e instanceof UploadError ? e.message : "The upload failed. Try again.");
    }
  }

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="media-picker-title" className="m-auto w-[min(56rem,calc(100vw-2rem))] rounded-lg border border-rule bg-surface p-0 text-ink backdrop:bg-ink/40">
      <div className="flex items-center justify-between border-b border-rule px-5 py-3">
        <h2 id="media-picker-title" className="font-serif text-xl">{title}</h2>
        <button type="button" onClick={onClose} className="min-h-9 rounded px-3 hover:bg-sage">Close</button>
      </div>
      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <label className="min-h-11 cursor-pointer rounded-md bg-ink px-4 py-2.5 text-sm font-medium text-paper focus-within:outline focus-within:outline-3 focus-within:outline-accent">
          Upload new image
          <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
        </label>
        <form role="search" onSubmit={(e) => { e.preventDefault(); void load(q); }} className="ml-auto flex gap-2">
          <label htmlFor="media-search" className="sr-only">Search images</label>
          <input id="media-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="File name or alt text" className="min-h-11 rounded-md border border-rule px-3 text-sm" />
          <button type="submit" className="min-h-11 rounded-md border border-rule px-3 text-sm hover:bg-sage">Search</button>
        </form>
      </div>
      <div aria-live="polite" className="px-5">
        {status ? <p className="text-sm text-muted">{status}</p> : null}
        {error ? <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p> : null}
      </div>
      <ul className="grid max-h-[60vh] grid-cols-2 gap-3 overflow-y-auto p-5 sm:grid-cols-4">
        {items.length === 0 ? <li className="col-span-full py-8 text-center text-sm text-muted">No images yet. Upload one to get started.</li> : null}
        {items.map((m) => (
          <li key={m.id}>
            <button type="button" disabled={m.status !== "ready"} onClick={() => onSelect(m)}
              className="block w-full overflow-hidden rounded-md border border-rule text-left hover:ring-2 hover:ring-accent disabled:opacity-50">
              <span className="block aspect-[4/3] bg-sage">
                {m.preview ? <img src={m.preview.src} alt="" className="h-full w-full object-cover" /> : null}
              </span>
              <span className="block truncate px-2 py-1.5 text-xs">{m.fileName}</span>
              <span className="block px-2 pb-1.5 text-xs text-muted">{m.status === "ready" ? `${m.width}×${m.height}` : m.status}</span>
            </button>
          </li>
        ))}
      </ul>
    </dialog>
  );
}
