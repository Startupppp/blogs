"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { editorAction } from "@/lib/server/action";
import { deleteRedirect, redirectInputSchema, saveRedirect } from "@/lib/server/blog/redirects";
import { db } from "@/lib/server/db/client";

export async function saveRedirectAction(fd: FormData) {
  const statusCode = Number(fd.get("statusCode"));
  const result = await editorAction("redirects:manage", (editor) => saveRedirect(db(), editor, redirectInputSchema.parse({
    sourcePath: String(fd.get("sourcePath") ?? ""),
    targetPath: statusCode === 410 ? null : String(fd.get("targetPath") ?? "") || null,
    statusCode,
  })));
  revalidatePath("/redirects");
  return result;
}

export async function deleteRedirectAction(fd: FormData) {
  const result = await editorAction("redirects:manage", (editor) => deleteRedirect(db(), editor, z.string().uuid().parse(fd.get("redirectId"))));
  revalidatePath("/redirects");
  return result;
}
