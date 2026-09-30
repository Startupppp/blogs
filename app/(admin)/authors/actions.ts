"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { editorAction } from "@/lib/server/action";
import { archiveAuthor, authorInputSchema, saveAuthor } from "@/lib/server/blog/taxonomy";
import { db } from "@/lib/server/db/client";

const text = (fd: FormData, key: string) => String(fd.get(key) ?? "");

export async function saveAuthorAction(fd: FormData) {
  const result = await editorAction("taxonomy:manage", (editor) => saveAuthor(db(), editor, authorInputSchema.parse({
    authorId: text(fd, "authorId") || null, name: text(fd, "name"), slug: text(fd, "slug"), role: text(fd, "role"), bio: text(fd, "bio"),
    twitter: text(fd, "twitter"), linkedin: text(fd, "linkedin"), email: text(fd, "email"), avatarMediaId: text(fd, "avatarMediaId") || null,
  })));
  revalidatePath("/authors");
  return result;
}

export async function archiveAuthorAction(fd: FormData) {
  const result = await editorAction("taxonomy:manage", (editor) =>
    archiveAuthor(db(), editor, z.string().uuid().parse(fd.get("authorId")), fd.get("archived") === "true"));
  revalidatePath("/authors");
  return result;
}
