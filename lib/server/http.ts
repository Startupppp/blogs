import "server-only";
import { NextResponse } from "next/server";
import { env } from "./env";
import { toFailure } from "./action";

/**
 * Route handlers are cookie-authenticated POST endpoints, so they refuse any request whose Origin
 * is not this admin (server actions get the same check from Next.js).
 */
export function assertSameOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (origin !== env().ADMIN_ORIGIN) return NextResponse.json({ code: "bad_origin", message: "Cross-origin request refused" }, { status: 403 });
  return null;
}

export function errorResponse(error: unknown): NextResponse {
  const f = toFailure(error);
  return NextResponse.json({ code: f.code, message: f.message, fields: f.fields }, { status: f.status, headers: { "cache-control": "no-store" } });
}

export async function readJson(request: Request, maxBytes = 16 * 1024): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) throw Object.assign(new Error("payload too large"), { tooLarge: true });
  const text = await request.text();
  if (text.length > maxBytes) throw Object.assign(new Error("payload too large"), { tooLarge: true });
  return JSON.parse(text);
}
