import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import postgres from "postgres";
import type { TestProject } from "vitest/node";
import { startFakeS3 } from "../support/fake-s3";

/**
 * Builds a disposable database from the vendored shared schema (backend 0000 blog tables + 1705),
 * provisions the real least-privilege role with db/provision-editorial-role.sql, and connects the
 * tests AS THAT ROLE — so a missing grant fails a test instead of passing under the owner.
 *
 * Also starts a fake S3 store and a stand-in for the existing backend + public site that reads the
 * same database through the publication predicate, so publish → notify → verify runs for real.
 */
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? "postgresql://localhost:5432/blog_admin_test";
const APP_PASSWORD = "test-only-editorial-password-0123456789";
const SECRET = "t".repeat(48);

declare module "vitest" {
  export interface ProvidedContext {
    testEnv: Record<string, string>;
  }
}

function assertDisposable(url: string) {
  const u = new URL(url);
  const db = u.pathname.slice(1);
  if (!["localhost", "127.0.0.1"].includes(u.hostname) || !db.endsWith("_test")) {
    throw new Error(`Refusing to rebuild ${u.hostname}/${db}: tests only rebuild a local database named *_test`);
  }
  return db;
}

export default async function setup(project: TestProject) {
  const dbName = assertDisposable(OWNER_URL);
  const maintenance = postgres(OWNER_URL.replace(/\/[^/]+$/, "/postgres"), { max: 1, onnotice: () => {} });
  await maintenance.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await maintenance.unsafe(`CREATE DATABASE "${dbName}"`);
  await maintenance.end();

  const owner = postgres(OWNER_URL, { max: 2, onnotice: () => {} });
  await owner.unsafe(readFileSync("db/test-schema/0000_blog_legacy.sql", "utf8"));
  await owner.unsafe(readFileSync("db/test-schema/1705_blog_revisions_publication.sql", "utf8"));
  // A stand-in for the platform's private tables: the editorial role must not be able to read it.
  await owner.unsafe(`CREATE TABLE hr_people (id int primary key, salary int); INSERT INTO hr_people VALUES (1, 100);`);
  execFileSync("psql", [OWNER_URL, "-q", "-v", `admin_password=${APP_PASSWORD}`, "-f", "db/provision-editorial-role.sql"], { stdio: "pipe" });

  const s3 = await startFakeS3();

  const predicate = `p.status = 'published' AND p.published_revision_id IS NOT NULL AND p.archived_at IS NULL AND p.deleted_at IS NULL AND p.published_at <= (now() AT TIME ZONE 'UTC')`;
  const site = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://site");
    if (req.method === "POST" && url.pathname === "/blog/internal/invalidate") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const body = Buffer.concat(chunks).toString("utf8");
      const ts = String(req.headers["x-blog-timestamp"] ?? "");
      const eventId = String(req.headers["x-blog-event-id"] ?? "");
      const expected = `v1=${createHmac("sha256", SECRET).update(`${ts}.${eventId}.${body}`).digest("hex")}`;
      const given = String(req.headers["x-blog-signature"] ?? "");
      if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
        res.writeHead(401).end();
        return;
      }
      const { postId } = JSON.parse(body) as { postId: string };
      const [row] = await owner.unsafe(`SELECT p.published_revision_id FROM blog_posts p WHERE p.id = $1 AND ${predicate}`, [postId]);
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ success: true, data: { acknowledged: true, duplicate: false, publishedRevisionId: row?.published_revision_id ?? null } }));
      return;
    }
    const match = /^\/blogs\/([a-z0-9-]+)$/.exec(url.pathname);
    // Simulates a public site that is down for particular articles.
    if (req.method === "GET" && match?.[1]?.startsWith("unreachable-")) {
      res.writeHead(503).end();
      return;
    }
    if (req.method === "GET" && match) {
      const [row] = await owner.unsafe(`SELECT p.published_revision_id, p.title FROM blog_posts p WHERE p.slug = $1 AND ${predicate}`, [match[1] ?? ""]);
      if (row) {
        res.writeHead(200, { "content-type": "text/html" })
          .end(`<html><head><meta name="streamline:revision" content="${row.published_revision_id}"></head><body>${row.title}</body></html>`);
        return;
      }
      const [gone] = await owner.unsafe(`SELECT status_code FROM blog_redirects WHERE source_path = $1`, [url.pathname]);
      res.writeHead(gone?.status_code === 410 ? 410 : 404).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const siteAddress = site.address();
  const sitePort = typeof siteAddress === "object" && siteAddress ? siteAddress.port : 0;
  const siteUrl = `http://127.0.0.1:${sitePort}`;

  const app = new URL(OWNER_URL);
  app.username = "blog_admin_app";
  app.password = APP_PASSWORD;

  project.provide("testEnv", {
    NODE_ENV: "test",
    TEST_OWNER_DATABASE_URL: OWNER_URL,
    DATABASE_URL: app.toString(),
    DATABASE_SSL: "disable",
    ADMIN_ORIGIN: "http://admin.test",
    AUTH_URL: "http://admin.test",
    PUBLIC_SITE_ORIGIN: siteUrl,
    BLOG_INVALIDATION_URL: `${siteUrl}/blog/internal/invalidate`,
    BLOG_INVALIDATION_SECRET: SECRET,
    AUTH_SECRET: "a".repeat(48),
    AUTH_GOOGLE_ID: "test-google-id",
    AUTH_GOOGLE_SECRET: "test-google-secret",
    CRON_SECRET: "c".repeat(48),
    R2_ENDPOINT: s3.url,
    R2_FORCE_PATH_STYLE: "true",
    R2_ACCESS_KEY_ID: "test",
    R2_SECRET_ACCESS_KEY: "test",
    R2_PRIVATE_BUCKET: "blog-private",
    R2_PUBLIC_BUCKET: "blog-public",
    MEDIA_PUBLIC_ORIGIN: "https://media.test",
  });

  return async () => {
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await s3.close();
    await owner.end();
  };
}
