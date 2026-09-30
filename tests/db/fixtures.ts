import sharp from "sharp";
import { db } from "@/lib/server/db/client";
import { blogAuthors, blogCategories, blogEditors } from "@/lib/server/db/schema";
import type { Editor } from "@/lib/server/auth/editor";
import { createUploadIntent, finalizeUpload } from "@/lib/server/media/upload";
import { runJobs } from "@/lib/server/jobs/runner";

let n = 0;
const unique = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

export async function makeEditor(role: Editor["role"], opts: { authorId?: string | null } = {}): Promise<Editor> {
  const email = `${role}-${unique()}@example.test`;
  const [row] = await db().insert(blogEditors).values({ email, subject: `sub-${email}`, role, authorId: opts.authorId ?? null })
    .returning({ id: blogEditors.id, email: blogEditors.email, name: blogEditors.name, role: blogEditors.role, authorId: blogEditors.authorId });
  if (!row) throw new Error("editor insert failed");
  return row;
}

export async function makeAuthor() {
  const u = unique();
  const [row] = await db().insert(blogAuthors).values({ name: `Author ${u}`, slug: `author-${u}`, email: `a-${u}@example.test` }).returning();
  if (!row) throw new Error("author insert failed");
  return row;
}

export async function makeCategory() {
  const u = unique();
  const [row] = await db().insert(blogCategories).values({ name: `Category ${u}`, slug: `category-${u}` }).returning();
  if (!row) throw new Error("category insert failed");
  return row;
}

export async function testJpeg(width = 1600, height = 1000): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 40, g: 90, b: 60 } } }).jpeg({ quality: 80 }).toBuffer();
}

/** Uploads bytes the way the browser does: intent, PUT to the presigned URL, finalize, process. */
export async function uploadImage(editor: Editor, bytes: Buffer, declaredMime = "image/jpeg") {
  const intent = await createUploadIntent(db(), editor, { fileName: "cover.jpg", size: bytes.byteLength, mime: declaredMime });
  const put = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.headers, body: new Uint8Array(bytes) });
  if (!put.ok) throw new Error(`upload PUT failed ${put.status}`);
  await finalizeUpload(db(), editor, intent.mediaId);
  await runJobs(db(), { budgetMs: 20_000 });
  return intent.mediaId;
}

/** A body comfortably over the publishing minimum. */
export function longDoc(extra: unknown[] = []) {
  const sentence = "Teams that write down who owns each step of onboarding finish it faster and with fewer surprises for the new hire. ";
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Why onboarding needs owners" }] },
      ...Array.from({ length: 8 }, () => ({ type: "paragraph", content: [{ type: "text", text: sentence.repeat(2) }] })),
      ...extra,
    ],
  };
}
