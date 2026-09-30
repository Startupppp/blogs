import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/server/db/client";
import { assertSchemaCompatible } from "@/lib/server/db/compat";
import { env } from "@/lib/server/env";
import { errorResponse } from "@/lib/server/http";
import { runJobs } from "@/lib/server/jobs/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(request: Request): boolean {
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${env().CRON_SECRET}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Called by the hosting scheduler (Vercel Cron sends GET with `Authorization: Bearer $CRON_SECRET`).
 * Claims due jobs under a lease, works for at most ~45 s, sweeps media, and reports what it did.
 */
async function handle(request: Request) {
  if (!authorised(request)) return NextResponse.json({ code: "unauthorized" }, { status: 401 });
  try {
    await assertSchemaCompatible(db());
    const result = await runJobs(db(), { budgetMs: 45_000, maxJobs: 50, sweep: true });
    return NextResponse.json({ processed: result.processed, failed: result.results.filter((r) => !r.ok).length }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = handle;
export const POST = handle;
