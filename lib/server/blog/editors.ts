import "server-only";
import { and, asc, count, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit";
import { assertCan, type Editor } from "../auth/editor";
import type { Db } from "../db/client";
import { blogEditors } from "../db/schema";
import { ServiceError, notFound } from "../errors";

export const editorInputSchema = z.object({
  editorId: z.string().uuid().nullable(),
  email: z.string().trim().toLowerCase().email().max(320),
  role: z.enum(["writer", "publisher", "admin"]),
  authorId: z.string().uuid().nullable(),
}).strict();

export async function listEditors(database: Db, editor: Editor) {
  assertCan(editor, "editors:manage");
  return database.select({
    id: blogEditors.id, email: blogEditors.email, name: blogEditors.name, role: blogEditors.role,
    authorId: blogEditors.authorId, bound: blogEditors.subject, disabledAt: blogEditors.disabledAt, createdAt: blogEditors.createdAt,
  }).from(blogEditors).orderBy(asc(blogEditors.email)).limit(500)
    .then((rows) => rows.map(({ bound, ...r }) => ({ ...r, signedInBefore: Boolean(bound) })));
}

async function otherActiveAdmins(database: Db, editorId: string): Promise<number> {
  const [row] = await database.select({ value: count() }).from(blogEditors)
    .where(and(eq(blogEditors.role, "admin"), isNull(blogEditors.disabledAt), ne(blogEditors.id, editorId)));
  return row?.value ?? 0;
}

/**
 * Grants editorial access to an email. The person gains access at their next Google sign-in with
 * that verified address; the row binds to their Google subject then. Access is never inferred from
 * a StreamlineOS organisation role.
 */
export async function saveEditor(database: Db, actor: Editor, input: z.infer<typeof editorInputSchema>) {
  assertCan(actor, "editors:manage");
  if (input.editorId) {
    if (input.editorId === actor.id && input.role !== "admin") throw new ServiceError(409, "self_demotion", "You cannot remove your own administrator role.");
    const [current] = await database.select().from(blogEditors).where(eq(blogEditors.id, input.editorId));
    if (!current) throw notFound("Editor");
    if (current.role === "admin" && input.role !== "admin" && (await otherActiveAdmins(database, current.id)) === 0) {
      throw new ServiceError(409, "last_admin", "Keep at least one active administrator.");
    }
    await database.update(blogEditors).set({ role: input.role, authorId: input.authorId, updatedAt: new Date() }).where(eq(blogEditors.id, input.editorId));
    await audit(database, { actorId: actor.id, action: "editor.update", editorId: input.editorId, summary: `role ${input.role}` });
    return { id: input.editorId };
  }
  const [row] = await database.insert(blogEditors).values({ email: input.email, role: input.role, authorId: input.authorId })
    .onConflictDoNothing({ target: blogEditors.email }).returning({ id: blogEditors.id });
  if (!row) throw new ServiceError(409, "duplicate", "That email already has editorial access.", { email: "Already added." });
  await audit(database, { actorId: actor.id, action: "editor.grant", editorId: row.id, summary: `role ${input.role}` });
  return row;
}

/** Revocation takes effect on the editor's next request: sessions re-read this row every time. */
export async function setEditorDisabled(database: Db, actor: Editor, editorId: string, disabled: boolean) {
  assertCan(actor, "editors:manage");
  if (editorId === actor.id) throw new ServiceError(409, "self_disable", "You cannot disable your own access.");
  const [target] = await database.select().from(blogEditors).where(eq(blogEditors.id, editorId));
  if (!target) throw notFound("Editor");
  if (disabled && target.role === "admin" && (await otherActiveAdmins(database, editorId)) === 0) {
    throw new ServiceError(409, "last_admin", "Keep at least one active administrator.");
  }
  await database.update(blogEditors).set({ disabledAt: disabled ? new Date() : null, updatedAt: new Date() }).where(eq(blogEditors.id, editorId));
  await audit(database, { actorId: actor.id, action: disabled ? "editor.revoke" : "editor.restore", editorId });
}
