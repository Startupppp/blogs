"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { editorAction } from "@/lib/server/action";
import { archiveCategory, categoryInputSchema, saveCategory } from "@/lib/server/blog/taxonomy";
import { db } from "@/lib/server/db/client";

const text = (fd: FormData, key: string) => String(fd.get(key) ?? "");

export async function saveCategoryAction(fd: FormData) {
  const result = await editorAction("taxonomy:manage", (editor) => saveCategory(db(), editor, categoryInputSchema.parse({
    categoryId: text(fd, "categoryId") || null, name: text(fd, "name"), slug: text(fd, "slug"), description: text(fd, "description"),
    color: text(fd, "color") || null, seoTitle: text(fd, "seoTitle"), seoDescription: text(fd, "seoDescription"),
  })));
  revalidatePath("/categories");
  return result;
}

export async function archiveCategoryAction(fd: FormData) {
  const result = await editorAction("taxonomy:manage", (editor) =>
    archiveCategory(db(), editor, z.string().uuid().parse(fd.get("categoryId")), fd.get("archived") === "true"));
  revalidatePath("/categories");
  return result;
}
