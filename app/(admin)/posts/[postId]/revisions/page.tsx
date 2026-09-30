import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireEditor } from "@/lib/server/auth/session";
import { AuthError } from "@/lib/server/auth/editor";
import { listRevisions } from "@/lib/server/blog/posts";
import { db } from "@/lib/server/db/client";
import { ServiceError } from "@/lib/server/errors";
import { LocalTime } from "@/components/ui/local-time";
import { RestoreButton } from "./restore-button";

export const metadata = { title: "Revision history" };

export default async function RevisionsPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  if (!z.string().uuid().safeParse(postId).success) notFound();
  const editor = await requireEditor();
  const { post, revisions } = await listRevisions(db(), editor, postId).catch((error: unknown) => {
    if ((error instanceof ServiceError && error.status === 404) || error instanceof AuthError) notFound();
    throw error;
  });
  return (
    <div className="max-w-4xl">
      <Link href={`/posts/${postId}`} className="text-sm underline underline-offset-2">← Back to the editor</Link>
      <h1 className="mt-3 font-serif text-3xl">Revision history</h1>
      <p className="mt-1 text-sm text-muted">Restoring copies an old revision into a new draft. Nothing is published and no history is lost.</p>
      <ol className="mt-6 divide-y divide-rule rounded-lg border border-rule bg-surface">
        {revisions.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <span className="w-10 font-mono text-muted">#{r.seq}</span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{r.title || "Untitled"}</p>
              <p className="text-xs text-muted">
                <LocalTime iso={r.updatedAt.toISOString()} /> · {r.wordCount} words
                {r.changeSummary ? ` · ${r.changeSummary}` : ""}
              </p>
            </div>
            <div className="flex gap-1.5 text-xs">
              {r.isPublished ? <span className="rounded-full bg-ok-soft px-2 py-0.5 text-ok">Live</span> : null}
              {r.isScheduled ? <span className="rounded-full bg-warn-soft px-2 py-0.5 text-warn">Scheduled</span> : null}
              {r.isWorking ? <span className="rounded-full bg-sage px-2 py-0.5">Current draft</span> : null}
            </div>
            <Link href={`/preview/${postId}?revision=${r.id}`} target="_blank" className="underline underline-offset-2">Preview</Link>
            {!r.isWorking ? <RestoreButton postId={postId} revisionId={r.id} version={post.version} seq={r.seq} /> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
