import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { runScheduledPublish } from "../blog/publish";
import type { Db } from "../db/client";
import { blogJobs } from "../db/schema";
import { sweepMedia } from "../media/library";
import { processMedia } from "../media/upload";
import { pruneRateLimits } from "../rate-limit";
import { deliverNotify } from "./notify";
import { claimJobs, completeJob, failJob, type ClaimedJob } from "./queue";

const LEASE_SECS = 120;

const processPayload = z.object({ mediaId: z.string().uuid(), checksum: z.string().length(64) });
const schedulePayload = z.object({ postId: z.string().uuid(), revisionId: z.string().uuid(), scheduleVersion: z.number().int() });

async function handle(database: Db, job: ClaimedJob): Promise<void> {
  switch (job.kind) {
    case "media.process":
      await processMedia(database, processPayload.parse(job.payload));
      return;
    case "post.publish_scheduled":
      await runScheduledPublish(database, schedulePayload.parse(job.payload));
      return;
    case "site.notify":
      await deliverNotify(database, job.payload);
      return;
  }
}

/**
 * Processes due jobs within a time budget sized to the hosting function limit. Every job is
 * persisted before any response and is safe to run twice; nothing depends on in-process timers.
 */
export async function runJobs(database: Db, opts: { budgetMs?: number; maxJobs?: number; onlyIds?: string[]; sweep?: boolean } = {}) {
  const budgetMs = opts.budgetMs ?? 25_000;
  const maxJobs = opts.maxJobs ?? 25;
  const started = Date.now();
  const results: { id: string; kind: string; ok: boolean; error?: string }[] = [];
  while (Date.now() - started < budgetMs && results.length < maxJobs) {
    const jobs = await claimJobs(database, Math.min(5, maxJobs - results.length), LEASE_SECS, undefined, opts.onlyIds);
    if (jobs.length === 0) break;
    for (const job of jobs) {
      try {
        await handle(database, job);
        await completeJob(database, job.id);
        results.push({ id: job.id, kind: job.kind, ok: true });
      } catch (error) {
        await failJob(database, job, error);
        results.push({ id: job.id, kind: job.kind, ok: false, error: error instanceof Error ? error.message.slice(0, 200) : "failed" });
      }
    }
  }
  if (opts.sweep) {
    await sweepMedia(database);
    await pruneRateLimits();
  }
  return { processed: results.length, results };
}

/** Runs one job right away (after its transaction committed), bounded; the queue remains the backstop. */
export async function runJobNow(database: Db, dedupeKey: string, budgetMs = 12_000) {
  const [job] = await database.select({ id: blogJobs.id }).from(blogJobs).where(eq(blogJobs.dedupeKey, dedupeKey)).limit(1);
  if (!job) return null;
  return runJobs(database, { onlyIds: [job.id], budgetMs, maxJobs: 1 });
}

export type PublicationState =
  | { state: "none" }
  | { state: "updating"; attempts: number; lastError: string | null; jobId: string }
  | { state: "live" | "withdrawn"; at: string }
  | { state: "failed"; lastError: string | null; jobId: string };

/** What the admin shows after a publish: persisted is not the same as confirmed live. */
export async function publicationState(database: Db, postId: string): Promise<PublicationState> {
  // ponytail: payload->>'postId' scan over a small editorial queue; add an expression index if it grows.
  const [job] = await database.select().from(blogJobs)
    .where(and(eq(blogJobs.kind, "site.notify"), sql`${blogJobs.payload}->>'postId' = ${postId}`))
    .orderBy(desc(blogJobs.createdAt)).limit(1);
  if (!job) return { state: "none" };
  if (job.status === "dead") return { state: "failed", lastError: job.lastError, jobId: job.id };
  if (job.status !== "done") return { state: "updating", attempts: job.attempts, lastError: job.lastError, jobId: job.id };
  const withdrawn = (job.payload as { revisionId?: string | null }).revisionId === null;
  return { state: withdrawn ? "withdrawn" : "live", at: (job.completedAt ?? job.updatedAt).toISOString() };
}
