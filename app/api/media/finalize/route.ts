import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/server/auth/session";
import { db } from "@/lib/server/db/client";
import { assertSchemaCompatible } from "@/lib/server/db/compat";
import { assertSameOrigin, errorResponse, readJson } from "@/lib/server/http";
import { runJobNow } from "@/lib/server/jobs/runner";
import { finalizeUpload } from "@/lib/server/media/upload";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({ mediaId: z.string().uuid() }).strict();

export async function POST(request: Request) {
  const refused = assertSameOrigin(request);
  if (refused) return refused;
  try {
    const editor = await requireEditor("media:upload");
    await assertSchemaCompatible(db());
    const input = bodySchema.safeParse(await readJson(request));
    if (!input.success) return NextResponse.json({ code: "invalid", message: "Invalid request" }, { status: 400 });
    const result = await finalizeUpload(db(), editor, input.data.mediaId);
    // Process now, within this request's budget; if it runs out, the scheduled runner finishes it.
    if (result.processKey) await runJobNow(db(), result.processKey, 40_000);
    return NextResponse.json({ mediaId: input.data.mediaId }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
