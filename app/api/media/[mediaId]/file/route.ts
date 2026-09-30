import { GetObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/server/auth/session";
import { db } from "@/lib/server/db/client";
import { blogMedia } from "@/lib/server/db/schema";
import { env } from "@/lib/server/env";
import { errorResponse } from "@/lib/server/http";
import { r2 } from "@/lib/server/media/r2";

export const runtime = "nodejs";

const params = z.object({ mediaId: z.string().uuid() });

/**
 * Authorised proxy for PRIVATE draft image variants, used by the editor and the preview. The
 * response is private and never cached, so a leaked preview link shows nothing without a session.
 */
export async function GET(request: Request, ctx: { params: Promise<{ mediaId: string }> }) {
  try {
    await requireEditor("media:upload");
    const parsed = params.safeParse(await ctx.params);
    const variantChecksum = new URL(request.url).searchParams.get("variant") ?? "";
    if (!parsed.success || !/^[a-f0-9]{64}$/.test(variantChecksum)) return new NextResponse(null, { status: 404 });
    const [media] = await db().select().from(blogMedia).where(eq(blogMedia.id, parsed.data.mediaId));
    const variant = media?.status === "ready" ? media.variants.find((v) => v.checksum === variantChecksum) : undefined;
    if (!variant) return new NextResponse(null, { status: 404 });
    const object = await r2().send(new GetObjectCommand({ Bucket: env().R2_PRIVATE_BUCKET, Key: variant.privateKey }));
    const body = await object.Body?.transformToByteArray();
    if (!body) return new NextResponse(null, { status: 404 });
    return new NextResponse(Buffer.from(body), {
      headers: {
        "content-type": variant.mime,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
