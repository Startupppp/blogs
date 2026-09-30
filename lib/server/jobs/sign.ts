import { createHmac } from "node:crypto";

/**
 * `v1=` + hex HMAC-SHA256 over `${timestamp}.${eventId}.${rawBody}`. Must stay identical to
 * streamlineos-backend `src/modules/blog/blog-invalidation.service.ts` (signBlogEvent).
 */
export function signBlogEvent(secret: string, timestamp: string, eventId: string, rawBody: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${eventId}.${rawBody}`).digest("hex")}`;
}
