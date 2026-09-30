import { notFound } from "next/navigation";
import { z } from "zod";
import { requireEditor } from "@/lib/server/auth/session";
import { AuthError } from "@/lib/server/auth/editor";
import { loadEditorState } from "@/lib/server/blog/queries";
import { db } from "@/lib/server/db/client";
import { ServiceError } from "@/lib/server/errors";
import { PostEditor } from "@/components/editor/post-editor";

export const metadata = { title: "Edit post" };

export default async function EditPostPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  if (!z.string().uuid().safeParse(postId).success) notFound();
  const editor = await requireEditor();
  const state = await loadEditorState(db(), editor, postId).catch((error: unknown) => {
    if ((error instanceof ServiceError && error.status === 404) || error instanceof AuthError) notFound();
    throw error;
  });
  return <PostEditor initial={state} />;
}
