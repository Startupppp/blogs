import Link from "next/link";
import { z } from "zod";
import { requireEditor } from "@/lib/server/auth/session";
import { POST_FILTERS, listPostsForAdmin } from "@/lib/server/blog/queries";
import { db } from "@/lib/server/db/client";
import { LocalTime } from "@/components/ui/local-time";
import { StatusBadge } from "@/components/ui/status-badge";
import { createPostAction } from "./actions";

export const metadata = { title: "Posts" };

const searchSchema = z.object({
  filter: z.enum(POST_FILTERS).catch("all"),
  q: z.string().max(200).catch(""),
  page: z.coerce.number().int().min(1).max(1000).catch(1),
  error: z.string().max(300).optional().catch(undefined),
});

export default async function PostsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const editor = await requireEditor();
  const params = searchSchema.parse(await searchParams);
  const { items, total, pageSize } = await listPostsForAdmin(db(), editor, { filter: params.filter, q: params.q.trim(), page: params.page });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (next: Partial<typeof params>) => {
    const merged = { ...params, ...next };
    const qs = new URLSearchParams();
    if (merged.filter !== "all") qs.set("filter", merged.filter);
    if (merged.q) qs.set("q", merged.q);
    if (merged.page > 1) qs.set("page", String(merged.page));
    return `/posts${qs.size ? `?${qs}` : ""}`;
  };

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl">Posts</h1>
          <p className="mt-1 text-sm text-muted">{total} {total === 1 ? "post" : "posts"}{editor.role === "writer" ? " assigned to you" : ""}</p>
        </div>
        <form action={createPostAction}>
          <button type="submit" className="min-h-11 rounded-md bg-ink px-4 py-2 font-medium text-paper hover:opacity-90">New post</button>
        </form>
      </div>

      {params.error ? <p role="alert" className="mt-4 rounded-md bg-danger-soft px-4 py-3 text-sm text-danger">{params.error}</p> : null}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <nav aria-label="Filter posts by status" className="flex flex-wrap gap-1">
          {POST_FILTERS.map((f) => (
            <Link key={f} href={href({ filter: f, page: 1 })} aria-current={params.filter === f ? "page" : undefined}
              className={`rounded-full px-3 py-1.5 text-sm capitalize ${params.filter === f ? "bg-ink text-paper" : "bg-surface text-muted ring-1 ring-rule hover:text-ink"}`}>
              {f}
            </Link>
          ))}
        </nav>
        <form role="search" className="ml-auto flex gap-2" action="/posts">
          {params.filter !== "all" ? <input type="hidden" name="filter" value={params.filter} /> : null}
          <label htmlFor="post-search" className="sr-only">Search posts</label>
          <input id="post-search" name="q" defaultValue={params.q} placeholder="Search title, text or slug" className="min-h-11 w-64 rounded-md border border-rule bg-surface px-3 text-sm" />
          <button type="submit" className="min-h-11 rounded-md border border-rule bg-surface px-3 text-sm hover:bg-sage">Search</button>
        </form>
      </div>

      {items.length === 0 ? (
        <div className="mt-10 rounded-lg border border-dashed border-rule p-10 text-center">
          <p className="font-medium">{params.q ? "No posts match that search." : "No posts here yet."}</p>
          <p className="mt-1 text-sm text-muted">{params.q ? "Try fewer words or a different status." : "Create a post to start drafting."}</p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-rule bg-surface">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Posts</caption>
            <thead className="border-b border-rule text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Title</th>
                <th scope="col" className="px-4 py-3 font-medium">Status</th>
                <th scope="col" className="px-4 py-3 font-medium">Author</th>
                <th scope="col" className="px-4 py-3 font-medium">Assigned to</th>
                <th scope="col" className="px-4 py-3 font-medium">Updated</th>
                <th scope="col" className="px-4 py-3 font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id} className="border-b border-rule last:border-0">
                  <td className="px-4 py-3">
                    <Link href={`/posts/${p.id}`} className="font-medium hover:underline">{p.displayTitle || "Untitled draft"}</Link>
                    <div className="text-xs text-muted">/blogs/{p.slug}</div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge label={p.label} />
                    {p.scheduledFor ? <div className="mt-1 text-xs text-muted"><LocalTime iso={p.scheduledFor.toISOString()} /></div> : null}
                  </td>
                  <td className="px-4 py-3 text-muted">{p.authorName ?? "—"}</td>
                  <td className="px-4 py-3 text-muted">{p.ownerEmail ?? "—"}</td>
                  <td className="px-4 py-3 text-muted"><LocalTime iso={p.updatedAt.toISOString()} /></td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/preview/${p.id}`} className="text-sm underline underline-offset-2">Preview</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 ? (
        <nav aria-label="Pagination" className="mt-6 flex items-center justify-between text-sm">
          {params.page > 1 ? <Link href={href({ page: params.page - 1 })} className="underline">Previous</Link> : <span />}
          <span className="text-muted">Page {params.page} of {pages}</span>
          {params.page < pages ? <Link href={href({ page: params.page + 1 })} className="underline">Next</Link> : <span />}
        </nav>
      ) : null}
    </div>
  );
}
