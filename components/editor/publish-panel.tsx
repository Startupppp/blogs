"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { EditorState } from "@/lib/server/blog/queries";
import type { PublicationState } from "@/lib/server/jobs/runner";
import type { ActionResult } from "@/lib/server/action";
import { formatWithOffset, resolveWallTime } from "@/lib/content/schedule-time";
import {
  cancelScheduleAction, checkpointAction, deletePostAction, publicationStateAction, publishAction, publishCheckAction,
  reassignAction, restoreArchivedAction, retryNotifyAction, scheduleAction, unpublishAction,
} from "@/app/(admin)/posts/[postId]/actions";
import { LocalTime } from "@/components/ui/local-time";
import { StatusBadge } from "@/components/ui/status-badge";

interface Props {
  initial: EditorState;
  version: number;
  setVersion: (v: number) => void;
  dirty: boolean;
  flush: () => Promise<void>;
  onFieldErrors: (errors: Record<string, string>) => void;
}

const button = "min-h-11 rounded-md px-3 text-sm font-medium disabled:opacity-50";

export function PublishPanel({ initial, version, setVersion, dirty, flush, onFieldErrors }: Props) {
  const postId = initial.post.id;
  const [label, setLabel] = useState(initial.post.label);
  const [publication, setPublication] = useState<PublicationState>(initial.publication);
  const [check, setCheck] = useState<{ errors: Record<string, string>; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [when, setWhen] = useState("");
  const [choice, setChoice] = useState<"earlier" | "later">("earlier");
  const [scheduledFor, setScheduledFor] = useState(initial.post.scheduledFor);
  const [summary, setSummary] = useState("");
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const resolved = when ? resolveWallTime(when, timeZone) : null;
  const instant = resolved?.kind === "exact" ? resolved.instant : resolved?.kind === "ambiguous" ? resolved[choice] : null;
  const publicUrl = `/blogs/${initial.post.slug}`;

  // Persisted is not the same as live: poll until the website confirms or the retries give out.
  useEffect(() => {
    if (publication.state !== "updating") return;
    const t = setInterval(async () => {
      const res = await publicationStateAction(postId);
      if (res.ok) setPublication(res.data);
    }, 3000);
    return () => clearInterval(t);
  }, [publication.state, postId]);

  async function run<T>(name: string, fn: () => Promise<ActionResult<T>>, done?: (data: T) => void) {
    setBusy(name);
    setMessage(null);
    if (dirty) await flush();
    const res = await fn();
    setBusy(null);
    if (res.ok) {
      const next = (res.data as { version?: unknown } | null)?.version;
      if (typeof next === "number") setVersion(next);
      done?.(res.data);
      return;
    }
    onFieldErrors(res.fields);
    setMessage({ tone: "error", text: res.code === "schedule_in_past" ? "That time has passed. Use Publish now instead, or pick a later time." : res.message });
  }

  const reviewed = check && Object.keys(check.errors).length === 0;

  return (
    <section className="space-y-4 rounded-lg border border-rule bg-surface p-4" aria-labelledby="publish-heading">
      <div className="flex items-center justify-between">
        <h2 id="publish-heading" className="font-medium">Publishing</h2>
        <StatusBadge label={label} />
      </div>

      {publication.state === "updating" ? (
        <p role="status" className="rounded bg-warn-soft px-3 py-2 text-sm text-warn">
          Published — updating website… {publication.attempts > 1 ? `(attempt ${publication.attempts})` : ""}
        </p>
      ) : publication.state === "live" ? (
        <p role="status" className="rounded bg-ok-soft px-3 py-2 text-sm text-ok">Live on StreamlineOS. <a className="underline" href={`${initial.publicOrigin}${publicUrl}`} target="_blank" rel="noreferrer">View article</a></p>
      ) : publication.state === "withdrawn" ? (
        <p role="status" className="rounded bg-sage px-3 py-2 text-sm">Removed from the website.</p>
      ) : publication.state === "failed" ? (
        <div role="alert" className="space-y-2 rounded bg-danger-soft px-3 py-2 text-sm text-danger">
          <p>The change is saved, but the website did not confirm it{publication.lastError ? `: ${publication.lastError}` : "."}</p>
          {initial.can.publish ? (
            <button type="button" className="underline" onClick={() => void run("retry", () => retryNotifyAction({ postId, jobId: publication.jobId }), (d) => setPublication(d))}>Retry website update</button>
          ) : null}
        </div>
      ) : null}

      {scheduledFor ? <p className="text-sm">Scheduled for <strong>{formatWithOffset(new Date(scheduledFor), timeZone)}</strong>.</p> : null}

      <div className="flex flex-wrap gap-2">
        <Link href={`/preview/${postId}`} target="_blank" className={`${button} border border-rule hover:bg-sage inline-flex items-center`}>Preview</Link>
        <Link href={`/posts/${postId}/revisions`} className={`${button} border border-rule hover:bg-sage inline-flex items-center`}>History</Link>
      </div>

      {initial.can.publish ? (
        <>
          <button type="button" disabled={busy !== null} className={`${button} w-full border border-rule hover:bg-sage`}
            onClick={() => void run("check", () => publishCheckAction(postId), (d) => { setCheck(d); onFieldErrors(d.errors); })}>
            {busy === "check" ? "Checking…" : "Check before publishing"}
          </button>

          {check ? (
            <div className="space-y-2 text-sm">
              {Object.keys(check.errors).length ? (
                <div role="alert" className="rounded bg-danger-soft px-3 py-2 text-danger">
                  <p className="font-medium">Fix before publishing:</p>
                  <ul className="mt-1 list-disc pl-5">{Object.entries(check.errors).map(([k, v]) => <li key={k}>{v}</li>)}</ul>
                </div>
              ) : <p className="rounded bg-ok-soft px-3 py-2 text-ok">Ready to publish.</p>}
              {check.warnings.length ? (
                <div className="rounded bg-warn-soft px-3 py-2 text-warn">
                  <p className="font-medium">Worth checking:</p>
                  <ul className="mt-1 list-disc pl-5">{check.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                </div>
              ) : null}
            </div>
          ) : null}

          <button type="button" disabled={busy !== null || !reviewed} className={`${button} w-full bg-ink text-paper hover:opacity-90`}
            onClick={() => void run("publish", () => publishAction({ postId, expectedVersion: version }), (d) => {
              setLabel("Published"); setScheduledFor(null); setPublication(d.publication); setCheck(null);
              setMessage({ tone: "ok", text: "Published. The website is being updated." });
            })}>
            {busy === "publish" ? "Publishing…" : initial.post.publishedRevisionId ? "Publish changes" : "Publish now"}
          </button>
          {!reviewed ? <p className="text-xs text-muted">Run the check first; publishing is enabled when nothing blocks it.</p> : null}

          <fieldset className="space-y-2 border-t border-rule pt-4">
            <legend className="text-sm font-medium">Schedule</legend>
            <label htmlFor="schedule-at" className="text-sm">Date and time ({timeZone})</label>
            <input id="schedule-at" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="min-h-11 w-full rounded-md border border-rule px-3 text-sm" />
            {resolved?.kind === "nonexistent" ? <p role="alert" className="text-sm text-danger">That time does not exist in {timeZone} (the clocks skip it). Choose another.</p> : null}
            {resolved?.kind === "invalid" ? <p role="alert" className="text-sm text-danger">Enter a valid date and time.</p> : null}
            {resolved?.kind === "ambiguous" ? (
              <div role="radiogroup" aria-label="That time happens twice" className="space-y-1 text-sm">
                <p>That time happens twice in {timeZone}. Which one?</p>
                {(["earlier", "later"] as const).map((k) => (
                  <label key={k} className="flex items-center gap-2">
                    <input type="radio" name="dst-choice" checked={choice === k} onChange={() => setChoice(k)} /> {formatWithOffset(resolved[k], timeZone)}
                  </label>
                ))}
              </div>
            ) : null}
            {instant ? <p className="text-xs text-muted">Publishes at {formatWithOffset(instant, timeZone)} ({instant.toISOString()} UTC).</p> : null}
            <button type="button" disabled={busy !== null || !instant || !reviewed} className={`${button} w-full border border-rule hover:bg-sage`}
              onClick={() => instant && void run("schedule", () => scheduleAction({ postId, expectedVersion: version, when: instant.toISOString() }), (d) => { setScheduledFor(d.scheduledFor); setLabel("Scheduled"); setMessage({ tone: "ok", text: "Scheduled." }); })}>
              {busy === "schedule" ? "Scheduling…" : "Schedule"}
            </button>
            {scheduledFor ? (
              <button type="button" disabled={busy !== null} className={`${button} w-full text-danger hover:bg-danger-soft`}
                onClick={() => void run("cancel", () => cancelScheduleAction({ postId, expectedVersion: version }), () => { setScheduledFor(null); setLabel(initial.post.publishedRevisionId ? "Published" : "Draft"); })}>
                Cancel schedule
              </button>
            ) : null}
          </fieldset>

          <div className="space-y-2 border-t border-rule pt-4">
            {label.startsWith("Published") ? (
              <button type="button" disabled={busy !== null} className={`${button} w-full text-danger hover:bg-danger-soft`}
                onClick={() => confirm("Remove this article from the website now? Its revisions are kept.") && void run("unpublish", () => unpublishAction({ postId, expectedVersion: version }), (d) => { setLabel("Archived"); setPublication(d.publication); })}>
                Unpublish
              </button>
            ) : null}
            {label === "Archived" ? (
              <button type="button" disabled={busy !== null} className={`${button} w-full border border-rule hover:bg-sage`}
                onClick={() => void run("restore", () => restoreArchivedAction({ postId, expectedVersion: version }), () => setLabel("Draft"))}>
                Restore as draft
              </button>
            ) : null}
            <button type="button" disabled={busy !== null} className={`${button} w-full text-danger hover:bg-danger-soft`}
              onClick={() => confirm("Delete this post? If it was public, its URL will answer 410 Gone.") && void run("delete", () => deletePostAction({ postId, expectedVersion: version }))}>
              Delete post
            </button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted">A publisher reviews and publishes this post. Your edits save automatically.</p>
      )}

      <div className="space-y-2 border-t border-rule pt-4">
        <label htmlFor="checkpoint" className="text-sm font-medium">Save a named revision</label>
        <div className="flex gap-2">
          <input id="checkpoint" value={summary} maxLength={200} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Ready for review" className="min-h-11 flex-1 rounded-md border border-rule px-3 text-sm" />
          <button type="button" disabled={busy !== null} className={`${button} border border-rule hover:bg-sage`}
            onClick={() => void run("checkpoint", () => checkpointAction({ postId, expectedVersion: version, summary }), () => { setSummary(""); setMessage({ tone: "ok", text: "Revision saved." }); })}>
            Save
          </button>
        </div>
      </div>

      {initial.can.reassign && initial.owners.length ? (
        <div className="space-y-2 border-t border-rule pt-4">
          <label htmlFor="owner" className="text-sm font-medium">Assigned to</label>
          <select id="owner" defaultValue={initial.post.ownerEditorId ?? ""} className="min-h-11 w-full rounded-md border border-rule px-3 text-sm"
            onChange={(e) => e.target.value && void run("reassign", () => reassignAction({ postId, expectedVersion: version, ownerEditorId: e.target.value }))}>
            <option value="" disabled>Unassigned</option>
            {initial.owners.map((o) => <option key={o.id} value={o.id}>{o.email}</option>)}
          </select>
        </div>
      ) : null}

      <div aria-live="polite">
        {message ? <p role={message.tone === "error" ? "alert" : "status"} className={`text-sm ${message.tone === "error" ? "text-danger" : "text-ok"}`}>{message.text}</p> : null}
      </div>

      {initial.events.length ? (
        <details className="border-t border-rule pt-4 text-sm">
          <summary className="cursor-pointer font-medium">Activity</summary>
          <ol className="mt-2 space-y-1.5 text-muted">
            {initial.events.map((e) => (
              <li key={e.id}><span className="text-ink">{e.action.replace(/^post\./, "").replaceAll("_", " ")}</span>{e.summary ? ` — ${e.summary}` : ""} · {e.actor ?? "system"} · <LocalTime iso={e.createdAt} /></li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}
