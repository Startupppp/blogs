import { desc, eq, sql } from "drizzle-orm";
import { requireEditor } from "@/lib/server/auth/session";
import { db } from "@/lib/server/db/client";
import { blogAuditEvents, blogEditors, blogJobs } from "@/lib/server/db/schema";
import { ActionForm } from "@/components/ui/action-form";
import { LocalTime } from "@/components/ui/local-time";
import { retryJobAction, runQueueAction } from "./actions";

export const metadata = { title: "Operations" };

export default async function OperationsPage() {
  await requireEditor("post:publish");
  const [[stats], dead, events] = await Promise.all([
    db().execute<{ due: number; running: number; dead: number; oldest_secs: number | null }>(sql`
      SELECT count(*) FILTER (WHERE status = 'pending' AND run_after <= now())::int AS due,
             count(*) FILTER (WHERE status = 'running')::int AS running,
             count(*) FILTER (WHERE status = 'dead')::int AS dead,
             extract(epoch FROM now() - min(run_after) FILTER (WHERE status = 'pending' AND run_after <= now()))::int AS oldest_secs
      FROM blog_jobs`),
    db().select().from(blogJobs).where(eq(blogJobs.status, "dead")).orderBy(desc(blogJobs.updatedAt)).limit(50),
    db().select({ id: blogAuditEvents.id, action: blogAuditEvents.action, summary: blogAuditEvents.summary, createdAt: blogAuditEvents.createdAt, actor: blogEditors.email })
      .from(blogAuditEvents).leftJoin(blogEditors, eq(blogEditors.id, blogAuditEvents.actorId)).orderBy(desc(blogAuditEvents.createdAt)).limit(50),
  ]);
  const oldest = stats?.oldest_secs ?? 0;
  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <h1 className="font-serif text-3xl">Operations</h1>
        <p className="mt-1 text-sm text-muted">Background work: image processing, scheduled publishing and website updates. The scheduler runs the queue every minute.</p>
      </div>
      <dl className="grid gap-3 sm:grid-cols-4">
        {[
          ["Due now", stats?.due ?? 0],
          ["Running", stats?.running ?? 0],
          ["Failed (dead)", stats?.dead ?? 0],
          ["Oldest due", oldest ? `${Math.round(oldest / 60)} min` : "—"],
        ].map(([k, v]) => (
          <div key={String(k)} className={`rounded-lg border bg-surface p-4 ${k === "Oldest due" && oldest > 300 ? "border-danger" : "border-rule"}`}>
            <dt className="text-xs uppercase tracking-wide text-muted">{k}</dt>
            <dd className="mt-1 text-2xl">{v}</dd>
          </div>
        ))}
      </dl>
      {oldest > 300 ? <p role="alert" className="rounded bg-danger-soft px-4 py-3 text-sm text-danger">The oldest due job has waited over five minutes. Check that the scheduler is calling /api/jobs/run.</p> : null}
      <ActionForm action={runQueueAction} submitLabel="Run the queue now" tone="quiet"><span /></ActionForm>

      <section>
        <h2 className="font-serif text-xl">Failed jobs</h2>
        {dead.length === 0 ? <p className="mt-2 text-sm text-muted">None.</p> : (
          <ul className="mt-3 space-y-2">
            {dead.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-rule bg-surface p-3 text-sm">
                <span className="font-mono text-xs">{j.kind}</span>
                <span className="text-muted">{j.attempts} attempts · <LocalTime iso={j.updatedAt.toISOString()} /></span>
                <span className="min-w-0 flex-1 truncate text-danger" title={j.lastError ?? ""}>{j.lastError}</span>
                <ActionForm action={retryJobAction} submitLabel="Retry" tone="quiet"><input type="hidden" name="jobId" value={j.id} /></ActionForm>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="font-serif text-xl">Audit log</h2>
        <ol className="mt-3 divide-y divide-rule rounded-lg border border-rule bg-surface text-sm">
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-3 px-4 py-2">
              <span className="font-mono text-xs">{e.action}</span>
              <span className="text-muted">{e.actor ?? "system"}</span>
              <span className="min-w-0 flex-1 truncate">{e.summary}</span>
              <span className="text-muted"><LocalTime iso={e.createdAt.toISOString()} /></span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
