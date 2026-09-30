"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { restoreRevisionAction } from "../actions";

export function RestoreButton({ postId, revisionId, version, seq }: { postId: string; revisionId: string; version: number; seq: number }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span>
      <button type="button" disabled={busy} className="min-h-9 rounded border border-rule px-3 hover:bg-sage"
        onClick={async () => {
          if (!confirm(`Copy revision #${seq} into a new draft? The live article is not changed.`)) return;
          setBusy(true);
          const res = await restoreRevisionAction({ postId, revisionId, expectedVersion: version });
          setBusy(false);
          if (res.ok) router.push(`/posts/${postId}`);
          else setError(res.message);
        }}>
        {busy ? "Restoring…" : "Restore"}
      </button>
      {error ? <span role="alert" className="ml-2 text-danger">{error}</span> : null}
    </span>
  );
}
