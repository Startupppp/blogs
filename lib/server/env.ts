import "server-only";
import { z } from "zod";

const url = z.string().url();
const origin = url.transform((v) => v.replace(/\/+$/, ""));
const secret = z.string().min(32);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** This admin's own origin, e.g. https://blog-admin.streamlineos.in. Used for Origin checks. */
  ADMIN_ORIGIN: origin,
  /** Canonical public site origin. Article links and previews point here, never at the admin. */
  PUBLIC_SITE_ORIGIN: origin,
  /** The existing backend's signed invalidation endpoint. */
  BLOG_INVALIDATION_URL: url,
  BLOG_INVALIDATION_SECRET: secret,
  /** Scoped editorial role on the SAME database the backend uses (see db/provision-editorial-role.sql). */
  DATABASE_URL: url,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
  DATABASE_SSL: z.enum(["require", "disable"]).default("require"),
  /** Auth.js base URL; must equal ADMIN_ORIGIN. Request URLs are rebuilt from it (see auth.ts). */
  AUTH_URL: origin,
  AUTH_SECRET: secret,
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),
  /** Bearer token the hosting scheduler sends to /api/jobs/run. Vercel Cron sends CRON_SECRET. */
  CRON_SECRET: secret,
  R2_ENDPOINT: url,
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  /** Only for S3-compatible test servers (MinIO); Cloudflare R2 uses virtual-hosted style. */
  R2_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  R2_PRIVATE_BUCKET: z.string().min(3),
  R2_PUBLIC_BUCKET: z.string().min(3),
  /** HTTPS custom domain serving R2_PUBLIC_BUCKET. */
  MEDIA_PUBLIC_ORIGIN: origin,
  PUBLISHERS_MANAGE_TAXONOMY: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Parsed lazily so `next build` never needs runtime secrets; the first request validates. */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid admin configuration: ${names}`);
  }
  if (parsed.data.R2_PRIVATE_BUCKET === parsed.data.R2_PUBLIC_BUCKET) {
    throw new Error("R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET must be different buckets");
  }
  if (parsed.data.AUTH_URL !== parsed.data.ADMIN_ORIGIN) {
    throw new Error("AUTH_URL must equal ADMIN_ORIGIN");
  }
  cached = parsed.data;
  return cached;
}
