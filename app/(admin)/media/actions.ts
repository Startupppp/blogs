"use server";

import { inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { editorAction } from "@/lib/server/action";
import { mediaSummary } from "@/lib/server/blog/queries";
import { db } from "@/lib/server/db/client";
import { blogMedia } from "@/lib/server/db/schema";
import { deleteMedia, listMedia, mediaMetaSchema, removeFromDelivery, updateMediaMeta } from "@/lib/server/media/library";
import { assertCan } from "@/lib/server/auth/editor";

const listSchema = z.object({ q: z.string().max(100).default(""), page: z.number().int().min(1).max(500).default(1) }).strict();

export async function listMediaAction(input: unknown) {
  return editorAction("media:upload", async (editor) => {
    const { q, page } = listSchema.parse(input);
    const result = await listMedia(db(), editor, { q: q.trim(), page });
    return { items: result.items.map(mediaSummary), total: result.total, pageSize: result.pageSize };
  });
}

export async function getMediaAction(input: unknown) {
  return editorAction("media:upload", async (editor) => {
    assertCan(editor, "media:upload");
    const ids = z.array(z.string().uuid()).max(50).parse(input);
    if (ids.length === 0) return [];
    return (await db().select().from(blogMedia).where(inArray(blogMedia.id, ids))).map(mediaSummary);
  });
}

export async function updateMediaAction(input: unknown) {
  const result = await editorAction("media:upload", (editor) => updateMediaMeta(db(), editor, mediaMetaSchema.parse(input)));
  revalidatePath("/media");
  return result;
}

export async function deleteMediaAction(mediaId: unknown) {
  const result = await editorAction("media:upload", (editor) => deleteMedia(db(), editor, z.string().uuid().parse(mediaId)));
  revalidatePath("/media");
  return result;
}

export async function removeFromDeliveryAction(mediaId: unknown) {
  const result = await editorAction("media:manage", (editor) => removeFromDelivery(db(), editor, z.string().uuid().parse(mediaId)));
  revalidatePath("/media");
  return result;
}
