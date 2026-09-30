"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { editorAction } from "@/lib/server/action";
import { editorInputSchema, saveEditor, setEditorDisabled } from "@/lib/server/blog/editors";
import { db } from "@/lib/server/db/client";

export async function saveEditorAction(fd: FormData) {
  const result = await editorAction("editors:manage", (actor) => saveEditor(db(), actor, editorInputSchema.parse({
    editorId: String(fd.get("editorId") ?? "") || null,
    email: String(fd.get("email") ?? ""),
    role: String(fd.get("role") ?? ""),
    authorId: String(fd.get("authorId") ?? "") || null,
  })));
  revalidatePath("/editors");
  return result;
}

export async function setEditorDisabledAction(fd: FormData) {
  const result = await editorAction("editors:manage", (actor) =>
    setEditorDisabled(db(), actor, z.string().uuid().parse(fd.get("editorId")), fd.get("disabled") === "true"));
  revalidatePath("/editors");
  return result;
}
