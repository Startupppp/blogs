import "server-only";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { SLUG_PATTERN } from "@/lib/content/slug";
import { audit } from "../audit";
import { assertCan, type Editor } from "../auth/editor";
import type { Db } from "../db/client";
import { blogPosts, blogRedirects } from "../db/schema";
import { ServiceError, notFound } from "../errors";

const blogPath = z.string().trim().regex(/^\/blogs(\/[a-z0-9][a-z0-9/-]*)?$/, "Use a /blogs/… path on this site").max(600);

export const redirectInputSchema = z.object({
  sourcePath: blogPath.refine((p) => p !== "/blogs", "The blog home cannot be redirected"),
  targetPath: blogPath.nullable(),
  statusCode: z.union([z.literal(301), z.literal(410)]),
}).strict();

export async function listRedirects(database: Db, editor: Editor) {
  assertCan(editor, "redirects:manage");
  return database.select().from(blogRedirects).orderBy(desc(blogRedirects.updatedAt)).limit(500);
}

/**
 * Adds a manual redirect or retirement. Targets must stay on /blogs (never an external URL), are
 * followed to their final destination so every redirect is a single hop, and a target that leads
 * back to the source is refused. A live article's own URL cannot be redirected away.
 */
export async function saveRedirect(database: Db, editor: Editor, input: z.infer<typeof redirectInputSchema>) {
  assertCan(editor, "redirects:manage");
  if (input.statusCode === 301 && !input.targetPath) throw new ServiceError(422, "invalid", "Choose where the old URL should go.", { targetPath: "Required for a redirect." });
  const slug = input.sourcePath.split("/")[2] ?? "";
  if (SLUG_PATTERN.test(slug) && input.sourcePath === `/blogs/${slug}`) {
    const [live] = await database.select({ id: blogPosts.id }).from(blogPosts).where(eq(blogPosts.slug, slug)).limit(1);
    if (live) throw new ServiceError(409, "is_article", "A post uses this URL. Change the post's URL instead.", { sourcePath: "A post uses this URL." });
  }
  let target = input.statusCode === 301 ? input.targetPath : null;
  for (let hops = 0; target && hops < 10; hops++) {
    if (target === input.sourcePath) throw new ServiceError(422, "loop", "This redirect would loop back to itself.", { targetPath: "Loops back to the old URL." });
    const [next] = await database.select().from(blogRedirects).where(eq(blogRedirects.sourcePath, target));
    if (!next || next.statusCode !== 301 || !next.targetPath) break;
    target = next.targetPath;
  }
  await database.insert(blogRedirects).values({ sourcePath: input.sourcePath, targetPath: target, statusCode: input.statusCode })
    .onConflictDoUpdate({ target: blogRedirects.sourcePath, set: { targetPath: target, statusCode: input.statusCode, updatedAt: new Date() } });
  if (target) {
    // Anything that pointed at the source now points straight at the final target.
    await database.update(blogRedirects).set({ targetPath: target, updatedAt: new Date() }).where(eq(blogRedirects.targetPath, input.sourcePath));
  }
  await audit(database, { actorId: editor.id, action: "redirect.save", summary: `${input.sourcePath} → ${target ?? "410"}` });
}

export async function deleteRedirect(database: Db, editor: Editor, redirectId: string) {
  assertCan(editor, "redirects:manage");
  const [row] = await database.delete(blogRedirects).where(eq(blogRedirects.id, redirectId)).returning();
  if (!row) throw notFound("Redirect");
  await audit(database, { actorId: editor.id, action: "redirect.delete", summary: row.sourcePath });
}
