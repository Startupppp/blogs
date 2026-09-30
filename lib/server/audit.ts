import "server-only";
import type { Db, Tx } from "./db/client";
import { blogAuditEvents } from "./db/schema";

export interface AuditEntry {
  actorId: string | null;
  action: string;
  postId?: string | null;
  revisionId?: string | null;
  mediaId?: string | null;
  authorId?: string | null;
  categoryId?: string | null;
  editorId?: string | null;
  /** A short human summary. Never article text, tokens, URLs with signatures, or secrets. */
  summary?: string;
}

export async function audit(tx: Db | Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(blogAuditEvents).values({
    actorId: entry.actorId,
    action: entry.action,
    postId: entry.postId ?? null,
    revisionId: entry.revisionId ?? null,
    mediaId: entry.mediaId ?? null,
    authorId: entry.authorId ?? null,
    categoryId: entry.categoryId ?? null,
    editorId: entry.editorId ?? null,
    summary: entry.summary?.slice(0, 500) ?? null,
  });
}
