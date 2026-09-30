"use server";

import { redirect } from "next/navigation";
import { editorAction } from "@/lib/server/action";
import { createPost } from "@/lib/server/blog/posts";
import { db } from "@/lib/server/db/client";

export async function createPostAction() {
  const result = await editorAction("post:create", (editor) => createPost(db(), editor));
  if (!result.ok) redirect(`/posts?error=${encodeURIComponent(result.message)}`);
  redirect(`/posts/${result.data.postId}`);
}
