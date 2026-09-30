"use client";

import { useEffect, useRef } from "react";

export interface ConflictDetail {
  version: number;
  title: string;
  excerpt: string;
  text: string;
  savedAt: string;
}

interface Props {
  detail: ConflictDetail | null;
  mine: { title: string; excerpt: string };
  onKeepMine: () => void;
  onLoadTheirs: () => void;
  onClose: () => void;
}

/**
 * Shown when a save is refused because someone else saved first. Nothing is overwritten
 * silently: the editor compares, then either keeps their own version (an intentional overwrite of
 * the newer save) or loads the other one.
 */
export function ConflictDialog({ detail, mine, onKeepMine, onLoadTheirs, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (detail && !d.open) d.showModal();
    if (!detail && d.open) d.close();
  }, [detail]);

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="conflict-title" className="m-auto w-[min(48rem,calc(100vw-2rem))] rounded-lg border border-rule bg-surface p-0 text-ink backdrop:bg-ink/40">
      {detail ? (
        <div className="space-y-4 p-6">
          <h2 id="conflict-title" className="font-serif text-2xl">Someone else saved this post</h2>
          <p className="text-sm text-muted">Their version was saved at {new Date(detail.savedAt).toLocaleString()}. Your changes are still here and have not been saved.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <section className="rounded-md border border-rule p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Your version</h3>
              <p className="mt-2 font-medium">{mine.title || "Untitled"}</p>
              <p className="mt-1 text-sm">{mine.excerpt}</p>
            </section>
            <section className="rounded-md border border-rule p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Their version</h3>
              <p className="mt-2 font-medium">{detail.title || "Untitled"}</p>
              <p className="mt-1 text-sm">{detail.excerpt}</p>
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer">Their article text</summary>
                <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-muted">{detail.text || "(empty)"}</p>
              </details>
            </section>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={onLoadTheirs} className="min-h-11 rounded-md border border-rule px-4 text-sm hover:bg-sage">Discard mine and load theirs</button>
            <button type="button" onClick={onKeepMine} className="min-h-11 rounded-md bg-ink px-4 text-sm font-medium text-paper">Keep mine (replaces theirs)</button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
