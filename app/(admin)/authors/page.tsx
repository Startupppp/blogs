import { requireEditor } from "@/lib/server/auth/session";
import { listAuthors } from "@/lib/server/blog/taxonomy";
import { db } from "@/lib/server/db/client";
import { ActionForm, inputClass, labelClass } from "@/components/ui/action-form";
import { archiveAuthorAction, saveAuthorAction } from "./actions";
import { AvatarField } from "./avatar-field";

export const metadata = { title: "Authors" };

type Author = Awaited<ReturnType<typeof listAuthors>>[number];

function AuthorFields({ author }: { author?: Author }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="authorId" value={author?.id ?? ""} />
      <label className={labelClass}>Name<input name="name" required maxLength={200} defaultValue={author?.name} className={inputClass} /></label>
      <label className={labelClass}>URL slug {author ? <span className="font-normal text-muted">(fixed: /blogs/author/{author.slug})</span> : null}
        <input name="slug" maxLength={120} defaultValue={author?.slug} disabled={Boolean(author)} placeholder="From the name" className={inputClass} />
      </label>
      <label className={labelClass}>Role or title<input name="role" maxLength={100} defaultValue={author?.role ?? ""} className={inputClass} /></label>
      <label className={labelClass}>Private email <span className="font-normal text-muted">(never shown publicly)</span><input name="email" type="email" maxLength={320} defaultValue={author?.email ?? ""} className={inputClass} /></label>
      <label className={labelClass}>X / Twitter handle<input name="twitter" maxLength={100} defaultValue={author?.twitter ?? ""} className={inputClass} /></label>
      <label className={labelClass}>LinkedIn handle<input name="linkedin" maxLength={200} defaultValue={author?.linkedin ?? ""} className={inputClass} /></label>
      <label className={`${labelClass} sm:col-span-2`}>Public biography<textarea name="bio" rows={3} maxLength={2000} defaultValue={author?.bio ?? ""} className={inputClass} /></label>
      <div className="sm:col-span-2"><AvatarField current={author?.avatar ?? null} /></div>
    </div>
  );
}

export default async function AuthorsPage() {
  await requireEditor("taxonomy:manage");
  const authors = await listAuthors(db());
  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <h1 className="font-serif text-3xl">Authors</h1>
        <p className="mt-1 text-sm text-muted">Public author profiles. Only the name, role, biography, portrait and social handles are ever published.</p>
      </div>
      <details className="rounded-lg border border-rule bg-surface p-4">
        <summary className="cursor-pointer font-medium">Add an author</summary>
        <ActionForm action={saveAuthorAction} submitLabel="Create author" className="mt-4 space-y-4"><AuthorFields /></ActionForm>
      </details>
      <ul className="space-y-3">
        {authors.map((a) => (
          <li key={a.id} className="rounded-lg border border-rule bg-surface p-4">
            <details>
              <summary className="flex cursor-pointer flex-wrap items-center gap-3">
                <span className="font-medium">{a.name}</span>
                <span className="text-sm text-muted">/blogs/author/{a.slug} · {a.livePosts} published</span>
                {a.archivedAt ? <span className="rounded-full bg-rule px-2 py-0.5 text-xs">Archived</span> : null}
              </summary>
              <ActionForm action={saveAuthorAction} submitLabel="Save" className="mt-4 space-y-4"><AuthorFields author={a} /></ActionForm>
              <ActionForm action={archiveAuthorAction} submitLabel={a.archivedAt ? "Restore author" : "Archive author"} tone={a.archivedAt ? "quiet" : "danger"} className="mt-3">
                <input type="hidden" name="authorId" value={a.id} />
                <input type="hidden" name="archived" value={a.archivedAt ? "false" : "true"} />
              </ActionForm>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
