import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/server/db/client";
import { assertSchemaCompatible, SUPPORTED_SCHEMA_VERSIONS } from "@/lib/server/db/compat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Readiness: database reachable and the shared schema at a version this build supports. */
export async function GET() {
  try {
    await assertSchemaCompatible(db());
    const [backlog] = await db().execute<{ due: number; dead: number; oldest_secs: number | null }>(sql`
      SELECT count(*) FILTER (WHERE status = 'pending' AND run_after <= now())::int AS due,
             count(*) FILTER (WHERE status = 'dead')::int AS dead,
             extract(epoch FROM now() - min(run_after) FILTER (WHERE status = 'pending' AND run_after <= now()))::int AS oldest_secs
      FROM blog_jobs`);
    return NextResponse.json({ status: "ready", schemaVersions: SUPPORTED_SCHEMA_VERSIONS, jobs: backlog }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "unready" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
