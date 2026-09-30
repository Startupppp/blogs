import "server-only";
import { sql } from "drizzle-orm";
import { db } from "./db/client";
import { ServiceError } from "./errors";

/**
 * Fixed-window limiter in the shared database, so the limit holds across every server instance.
 * ponytail: one row per bucket-window upsert; move to Redis if write volume ever matters.
 */
export async function consumeRateLimit(bucket: string, limit: number, windowSecs: number): Promise<void> {
  const rows = await db().execute<{ count: number }>(sql`
    INSERT INTO blog_rate_limits (bucket, window_start, count)
    VALUES (${bucket}, to_timestamp(floor(extract(epoch FROM now()) / ${windowSecs}) * ${windowSecs}), 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET count = blog_rate_limits.count + 1
    RETURNING count`);
  const count = Number(rows[0]?.count ?? 0);
  if (count > limit) throw new ServiceError(429, "rate_limited", "Too many requests. Try again shortly.");
}

/** Removes windows older than a day; called by the job runner's sweep. */
export async function pruneRateLimits(): Promise<void> {
  await db().execute(sql`DELETE FROM blog_rate_limits WHERE window_start < now() - interval '1 day'`);
}
