import { requireEditor } from "@/lib/server/auth/session";
import { listCategories } from "@/lib/server/blog/taxonomy";
import { db } from "@/lib/server/db/client";
import { ActionForm, inputClass, labelClass } from "@/components/ui/action-form";
import { archiveCategoryAction, saveCategoryAction } from "./actions";

export const metadata = { title: "Categories" };

type Category = Awaited<ReturnType<typeof listCategories>>[number];

function CategoryFields({ category }: { category?: Category }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="categoryId" value={category?.id ?? ""} />
      <label className={labelClass}>Name<input name="name" required maxLength={100} defaultValue={category?.name} className={inputClass} /></label>
      <label className={labelClass}>URL slug {category ? <span className="font-normal text-muted">(fixed: /blogs/category/{category.slug})</span> : null}
        <input name="slug" maxLength={100} defaultValue={category?.slug} disabled={Boolean(category)} placeholder="From the name" className={inputClass} />
      </label>
      <label className={`${labelClass} sm:col-span-2`}>Introduction<textarea name="description" rows={3} maxLength={2000} defaultValue={category?.description ?? ""} className={inputClass} /></label>
      <label className={labelClass}>Search title<input name="seoTitle" maxLength={256} defaultValue={category?.seoTitle ?? ""} className={inputClass} /></label>
      <label className={labelClass}>Accent colour<input name="color" type="color" defaultValue={category?.color ?? "#263c32"} className="h-11 w-20 rounded-md border border-rule" /></label>
      <label className={`${labelClass} sm:col-span-2`}>Search description<textarea name="seoDescription" rows={2} maxLength={320} defaultValue={category?.seoDescription ?? ""} className={inputClass} /></label>
    </div>
  );
}

export default async function CategoriesPage() {
  await requireEditor("taxonomy:manage");
  const categories = await listCategories(db());
  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <h1 className="font-serif text-3xl">Categories</h1>
        <p className="mt-1 text-sm text-muted">Topic hubs. A category’s URL is fixed once created, so renaming never breaks links.</p>
      </div>
      <details className="rounded-lg border border-rule bg-surface p-4">
        <summary className="cursor-pointer font-medium">Add a category</summary>
        <ActionForm action={saveCategoryAction} submitLabel="Create category" className="mt-4 space-y-4"><CategoryFields /></ActionForm>
      </details>
      <ul className="space-y-3">
        {categories.map((c) => (
          <li key={c.id} className="rounded-lg border border-rule bg-surface p-4">
            <details>
              <summary className="flex cursor-pointer flex-wrap items-center gap-3">
                <span className="font-medium">{c.name}</span>
                <span className="text-sm text-muted">/blogs/category/{c.slug} · {c.livePosts} published</span>
                {c.archivedAt ? <span className="rounded-full bg-rule px-2 py-0.5 text-xs">Archived</span> : null}
              </summary>
              <ActionForm action={saveCategoryAction} submitLabel="Save" className="mt-4 space-y-4"><CategoryFields category={c} /></ActionForm>
              <ActionForm action={archiveCategoryAction} submitLabel={c.archivedAt ? "Restore category" : "Archive category"} tone={c.archivedAt ? "quiet" : "danger"} className="mt-3">
                <input type="hidden" name="categoryId" value={c.id} />
                <input type="hidden" name="archived" value={c.archivedAt ? "false" : "true"} />
              </ActionForm>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
