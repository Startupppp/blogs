import "server-only";
import { auth } from "./auth";
import { AuthError, assertCan, loadEditor, type Editor } from "./editor";
import type { Capability } from "./roles";

/** The signed-in editor, or null. Never trusts a role or id from the client or the cookie. */
export async function currentEditor(): Promise<Editor | null> {
  const session = await auth();
  const email = session?.user?.email;
  const subject = session && "subject" in session && typeof session.subject === "string" ? session.subject : null;
  if (!email || !subject) return null;
  return loadEditor(email, subject);
}

export async function requireEditor(capability?: Capability): Promise<Editor> {
  const editor = await currentEditor();
  if (!editor) throw new AuthError(401);
  if (capability) assertCan(editor, capability);
  return editor;
}
