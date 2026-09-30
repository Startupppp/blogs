import { requireEditor } from "@/lib/server/auth/session";
import { listEditors } from "@/lib/server/blog/editors";
import { listAuthors } from "@/lib/server/blog/taxonomy";
import { db } from "@/lib/server/db/client";
import { ActionForm, inputClass, labelClass } from "@/components/ui/action-form";
import { saveEditorAction, setEditorDisabledAction } from "./actions";

export const metadata = { title: "Editors" };

const ROLES = [
  { value: "writer", label: "Writer — drafts assigned posts" },
  { value: "publisher", label: "Publisher — publishes and schedules" },
  { value: "admin", label: "Administrator — also manages access" },
];

export default async function EditorsPage() {
  const actor = await requireEditor("editors:manage");
  const [editors, authors] = await Promise.all([listEditors(db(), actor), listAuthors(db())]);
  const authorOptions = authors.filter((a) => !a.archivedAt);
  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <h1 className="font-serif text-3xl">Editorial access</h1>
        <p className="mt-1 text-sm text-muted">Access is granted per email and only through this list; a StreamlineOS organisation role never grants it. The person signs in with Google using that exact, verified address. Revoking takes effect on their next request.</p>
      </div>
      <ActionForm action={saveEditorAction} submitLabel="Grant access" className="space-y-4 rounded-lg border border-rule bg-surface p-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <input type="hidden" name="editorId" value="" />
          <label className={labelClass}>Google email<input name="email" type="email" required className={inputClass} /></label>
          <label className={labelClass}>Role<select name="role" className={inputClass}>{ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></label>
          <label className={labelClass}>Default author<select name="authorId" className={inputClass}><option value="">None</option>{authorOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        </div>
      </ActionForm>
      <ul className="space-y-3">
        {editors.map((e) => (
          <li key={e.id} className="rounded-lg border border-rule bg-surface p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{e.email}</span>
              <span className="text-sm text-muted">{e.signedInBefore ? "Has signed in" : "Not signed in yet"}</span>
              {e.disabledAt ? <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xs text-danger">Access revoked</span> : null}
              {e.id === actor.id ? <span className="rounded-full bg-sage px-2 py-0.5 text-xs">You</span> : null}
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-4">
              <ActionForm action={saveEditorAction} submitLabel="Update" tone="quiet" className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="editorId" value={e.id} />
                <input type="hidden" name="email" value={e.email} />
                <label className={labelClass}>Role<select name="role" defaultValue={e.role} className={inputClass}>{ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></label>
                <label className={labelClass}>Default author<select name="authorId" defaultValue={e.authorId ?? ""} className={inputClass}><option value="">None</option>{authorOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              </ActionForm>
              {e.id !== actor.id ? (
                <ActionForm action={setEditorDisabledAction} submitLabel={e.disabledAt ? "Restore access" : "Revoke access"} tone={e.disabledAt ? "quiet" : "danger"}
                  confirmMessage={e.disabledAt ? undefined : `Revoke ${e.email}'s editorial access now?`}>
                  <input type="hidden" name="editorId" value={e.id} />
                  <input type="hidden" name="disabled" value={e.disabledAt ? "false" : "true"} />
                </ActionForm>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
