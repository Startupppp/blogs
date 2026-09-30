import "server-only";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../db/client";
import { blogEditors } from "../db/schema";
import { env } from "../env";
import { can, canEditPost, type Capability, type EditorRole } from "./roles";

export interface Editor {
  id: string;
  email: string;
  name: string | null;
  role: EditorRole;
  authorId: string | null;
}

export class AuthError extends Error {
  constructor(readonly status: 401 | 403, message = status === 401 ? "Sign in required" : "Not allowed") {
    super(message);
  }
}

const editorColumns = {
  id: blogEditors.id,
  email: blogEditors.email,
  name: blogEditors.name,
  role: blogEditors.role,
  authorId: blogEditors.authorId,
};

/**
 * Admits a verified Google account only if an enabled editor row exists for its email, and binds
 * the row to the Google subject the first time. A row already bound to a different subject is
 * refused: an email address alone never re-assigns an editorial seat.
 */
export async function bindEditorOnSignIn(email: string, subject: string, name: string | null): Promise<Editor | null> {
  const normalized = email.toLowerCase();
  const [row] = await db()
    .update(blogEditors)
    .set({ subject, name: name ?? undefined, updatedAt: new Date() })
    .where(and(
      eq(blogEditors.email, normalized),
      isNull(blogEditors.disabledAt),
      or(isNull(blogEditors.subject), eq(blogEditors.subject, subject)),
    ))
    .returning(editorColumns);
  return row ?? null;
}

/** Re-reads the editor on every request, so a disabled or re-roled editor loses access at once. */
export async function loadEditor(email: string, subject: string): Promise<Editor | null> {
  const [row] = await db()
    .select(editorColumns)
    .from(blogEditors)
    .where(and(eq(blogEditors.email, email.toLowerCase()), eq(blogEditors.subject, subject), isNull(blogEditors.disabledAt)))
    .limit(1);
  return row ?? null;
}

export function policy() {
  return { publishersManageTaxonomy: env().PUBLISHERS_MANAGE_TAXONOMY };
}

export function assertCan(editor: Editor, capability: Capability): void {
  if (!can(editor.role, capability, policy())) throw new AuthError(403);
}

export function assertCanEditPost(editor: Editor, post: { ownerEditorId: string | null }): void {
  if (!canEditPost(editor, post, policy())) throw new AuthError(403);
}
