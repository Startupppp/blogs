import "server-only";
import { AuthError, type Editor } from "./auth/editor";
import { requireEditor } from "./auth/session";
import type { Capability } from "./auth/roles";
import { db } from "./db/client";
import { assertSchemaCompatible, SchemaIncompatibleError } from "./db/compat";
import { ServiceError } from "./errors";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string; fields: Record<string, string>; detail: unknown };

/** Maps any failure to a safe, serialisable result. Unknown errors never leak their message. */
export function toFailure(error: unknown): Extract<ActionResult<never>, { ok: false }> {
  if (error instanceof ServiceError) return { ok: false, status: error.status, code: error.code, message: error.message, fields: error.fields, detail: error.detail };
  if (error instanceof AuthError) return { ok: false, status: error.status, code: error.status === 401 ? "unauthenticated" : "forbidden", message: error.message, fields: {}, detail: null };
  if (error instanceof SchemaIncompatibleError) return { ok: false, status: 503, code: "schema_incompatible", message: "The blog database is being upgraded. Your changes are kept here; try again shortly.", fields: {}, detail: null };
  if (error instanceof Error && /ECONNREFUSED|ETIMEDOUT|terminating connection|Connection terminated|timeout/i.test(error.message)) {
    return { ok: false, status: 503, code: "unavailable", message: "The database is unavailable. Your changes are kept here; saving will retry.", fields: {}, detail: null };
  }
  console.error("[blog-admin] unexpected action failure", error instanceof Error ? error.name : typeof error);
  return { ok: false, status: 500, code: "internal", message: "Something went wrong. Your changes are kept here.", fields: {}, detail: null };
}

/**
 * Every server action goes through here: authenticate, authorise, check the shared-schema contract,
 * run, and return a result object. Validation of the action's input happens inside `fn`.
 */
export async function editorAction<T>(capability: Capability | null, fn: (editor: Editor) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const editor = await requireEditor(capability ?? undefined);
    await assertSchemaCompatible(db());
    return { ok: true, data: await fn(editor) };
  } catch (error) {
    return toFailure(error);
  }
}
