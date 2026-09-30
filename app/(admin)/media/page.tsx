import Link from "next/link";
import { z } from "zod";
import { requireEditor } from "@/lib/server/auth/session";
import { can } from "@/lib/server/auth/roles";
import { policy } from "@/lib/server/auth/editor";
import { mediaSummary } from "@/lib/server/blog/queries";
import { db } from "@/lib/server/db/client";
import { listMedia } from "@/lib/server/media/library";
import { MediaItemForms } from "./item-forms";
import { Uploader } from "./uploader";

export const metadata = { title: "Media" };

const STATUS_TEXT: Record<string, string> = { pending: "Upload not finished", processing: "Processing…", failed: "Failed", ready: "Ready" };

export default async function MediaPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const editor = await requireEditor("media:upload");
  const { q, page } = z.object({ q: z.string().max(100).catch(""), page: z.coerce.number().int().min(1).max(500).catch(1) }).parse(await searchParams);
  const { items, total, pageSize } = await listMedia(db(), editor, { q, page });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const canManage = can(editor.role, "media:manage", policy());
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl">Media</h1>
          <p className="mt-1 text-sm text-muted">JPEG, PNG or WebP up to 10 MB and 40 megapixels. Images stay private until a post using them is published.</p>
        </div>
        <Uploader />
      </div>
      <form role="search" action="/media" className="flex gap-2">
        <label htmlFor="media-q" className="sr-only">Search images</label>
        <input id="media-q" name="q" defaultValue={q} placeholder="File name or alt text" className="min-h-11 w-72 rounded-md border border-rule bg-surface px-3 text-sm" />
        <button type="submit" className="min-h-11 rounded-md border border-rule bg-surface px-3 text-sm hover:bg-sage">Search</button>
      </form>
      {items.length === 0 ? <p className="rounded-lg border border-dashed border-rule p-10 text-center text-muted">No images yet.</p> : null}
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((raw) => {
          const item = mediaSummary(raw);
          return (
            <li key={item.id} className="overflow-hidden rounded-lg border border-rule bg-surface">
              <div className="aspect-[16/9] bg-sage">{item.preview ? <img src={item.preview.src} alt={item.altDefault ?? ""} className="h-full w-full object-cover" /> : null}</div>
              <div className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="truncate font-medium">{item.fileName}</span>
                  <span className={item.status === "failed" ? "text-danger" : "text-muted"}>{STATUS_TEXT[item.status] ?? item.status}</span>
                  {item.width ? <span className="text-muted">{item.width}×{item.height}</span> : null}
                  {item.promoted ? <span className="rounded-full bg-ok-soft px-2 py-0.5 text-xs text-ok">Public</span> : null}
                </div>
                {item.failureReason ? <p className="text-sm text-danger">{item.failureReason}</p> : null}
                {!item.credit && item.status === "ready" ? <p className="text-xs text-warn">No source credit recorded.</p> : null}
                <details><summary className="cursor-pointer text-sm">Details and actions</summary><div className="mt-3"><MediaItemForms item={item} canManage={canManage} /></div></details>
              </div>
            </li>
          );
        })}
      </ul>
      {pages > 1 ? (
        <nav aria-label="Pagination" className="flex justify-between text-sm">
          {page > 1 ? <Link href={`/media?page=${page - 1}${q ? `&q=${encodeURIComponent(q)}` : ""}`} className="underline">Previous</Link> : <span />}
          <span className="text-muted">Page {page} of {pages}</span>
          {page < pages ? <Link href={`/media?page=${page + 1}${q ? `&q=${encodeURIComponent(q)}` : ""}`} className="underline">Next</Link> : <span />}
        </nav>
      ) : null}
    </div>
  );
}
