import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/server/auth/session";
import { db } from "@/lib/server/db/client";
import { assertSchemaCompatible } from "@/lib/server/db/compat";
import { assertSameOrigin, errorResponse, readJson } from "@/lib/server/http";
import { createUploadIntent, uploadIntentSchema } from "@/lib/server/media/upload";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const refused = assertSameOrigin(request);
  if (refused) return refused;
  try {
    const editor = await requireEditor("media:upload");
    await assertSchemaCompatible(db());
    const input = uploadIntentSchema.safeParse(await readJson(request));
    if (!input.success) return NextResponse.json({ code: "invalid", message: "Invalid upload request" }, { status: 400 });
    return NextResponse.json(await createUploadIntent(db(), editor, input.data), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
