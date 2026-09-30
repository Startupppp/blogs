import "server-only";
import { sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client";
import { blogJobs } from "../db/schema";

export type JobKind = "media.process" | "post.publish_scheduled" | "site.notify" | "media.cleanup";

export type ClaimedJob = {
  id: string;
  kind: JobKind;
  payload: unknown;
  attempts: number;
  max_attempts: number;
};

/**
 * Durable outbox. A job is written in the same transaction as the change it follows, so it exists
 * if and only if the change committed. `dedupeKey` makes enqueueing idempotent.
 */
export async function enqueue(tx: Db | Tx, kind: JobKind, payload: object, opts: { runAfter?: Date; dedupeKey?: string; maxAttempts?: number } = {}) {
  await tx
    .insert(blogJobs)
    .values({
      kind,
      payload,
      status: "pending",
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? 8,
      runAfter: opts.runAfter ?? new Date(),
      dedupeKey: opts.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: blogJobs.dedupeKey });
}

/**
 * Claims due jobs with a lease. `SKIP LOCKED` lets concurrent runners share the queue without
 * taking the same job; an expired lease (a crashed runner) makes the job claimable again.
 */
export async function claimJobs(database: Db, limit: number, leaseSecs: number, kinds?: JobKind[], ids?: string[]): Promise<ClaimedJob[]> {
  const kindFilter = kinds?.length ? sql`AND kind IN (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})` : sql``;
  const idFilter = ids?.length ? sql`AND id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})` : sql``;
  const rows = await database.execute<ClaimedJob>(sql`
    UPDATE blog_jobs SET status = 'running', attempts = attempts + 1,
      lease_until = now() + make_interval(secs => ${leaseSecs}), updated_at = now()
    WHERE id IN (
      SELECT id FROM blog_jobs
      WHERE ((status = 'pending' AND run_after <= now()) OR (status = 'running' AND lease_until < now()))
        ${kindFilter} ${idFilter}
      ORDER BY run_after
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, payload, attempts, max_attempts`);
  return [...rows];
}

export async function completeJob(database: Db, id: string): Promise<void> {
  await database.execute(sql`
    UPDATE blog_jobs SET status = 'done', completed_at = now(), lease_until = NULL, last_error = NULL, updated_at = now()
    WHERE id = ${id}`);
}

/** Exponential backoff from 15 s up to 30 min; `dead` after max attempts, kept for retry controls. */
export async function failJob(database: Db, job: ClaimedJob, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 900);
  const delaySecs = Math.min(15 * 2 ** Math.max(0, job.attempts - 1), 1800);
  await database.execute(sql`
    UPDATE blog_jobs SET
      status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
      run_after = now() + make_interval(secs => ${delaySecs}),
      lease_until = NULL, last_error = ${message}, updated_at = now()
    WHERE id = ${job.id}`);
}

/** Operator retry for a dead job: same payload, same id, attempts reset. */
export async function retryDeadJob(database: Db, id: string): Promise<boolean> {
  const rows = await database.execute(sql`
    UPDATE blog_jobs SET status = 'pending', attempts = 0, run_after = now(), last_error = NULL, updated_at = now()
    WHERE id = ${id} AND status = 'dead' RETURNING id`);
  return rows.length > 0;
}
