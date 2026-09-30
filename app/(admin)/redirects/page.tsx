import { requireEditor } from "@/lib/server/auth/session";
import { listRedirects } from "@/lib/server/blog/redirects";
import { db } from "@/lib/server/db/client";
import { ActionForm, inputClass, labelClass } from "@/components/ui/action-form";
import { deleteRedirectAction, saveRedirectAction } from "./actions";

export const metadata = { title: "Redirects" };

export default async function RedirectsPage() {
  const editor = await requireEditor("redirects:manage");
  const redirects = await listRedirects(db(), editor);
  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <h1 className="font-serif text-3xl">Redirects</h1>
        <p className="mt-1 text-sm text-muted">Changing a post's URL adds a redirect automatically. Add one here for other old /blogs addresses, or retire one with 410 Gone.</p>
      </div>
      <ActionForm action={saveRedirectAction} submitLabel="Save redirect" className="space-y-4 rounded-lg border border-rule bg-surface p-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <label className={labelClass}>Old path<input name="sourcePath" required placeholder="/blogs/old-address" className={inputClass} /></label>
          <label className={labelClass}>New path<input name="targetPath" placeholder="/blogs/new-address" className={inputClass} /></label>
          <label className={labelClass}>Type
            <select name="statusCode" className={inputClass} defaultValue="301">
              <option value="301">301 — moved permanently</option>
              <option value="410">410 — gone (no new path)</option>
            </select>
          </label>
        </div>
      </ActionForm>
      <div className="overflow-x-auto rounded-lg border border-rule bg-surface">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Redirects</caption>
          <thead className="border-b border-rule text-xs uppercase tracking-wide text-muted">
            <tr><th scope="col" className="px-4 py-3">Old path</th><th scope="col" className="px-4 py-3">Goes to</th><th scope="col" className="px-4 py-3">Source</th><th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            {redirects.length === 0 ? <tr><td colSpan={4} className="px-4 py-8 text-center text-muted">No redirects yet.</td></tr> : null}
            {redirects.map((r) => (
              <tr key={r.id} className="border-b border-rule last:border-0">
                <td className="px-4 py-3 font-mono text-xs">{r.sourcePath}</td>
                <td className="px-4 py-3 font-mono text-xs">{r.statusCode === 410 ? "410 Gone" : r.targetPath}</td>
                <td className="px-4 py-3 text-muted">{r.postId ? "Post URL change" : "Manual"}</td>
                <td className="px-4 py-3 text-right">
                  <ActionForm action={deleteRedirectAction} submitLabel="Delete" tone="danger" confirmMessage={`Delete the redirect from ${r.sourcePath}? That address will answer 404.`}>
                    <input type="hidden" name="redirectId" value={r.id} />
                  </ActionForm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
