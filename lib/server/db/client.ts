import "server-only";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as { blogAdminSql?: postgres.Sql; blogAdminDb?: Db };

/**
 * One bounded pool per server instance. `prepare: false` because a Neon (PgBouncer) pooled
 * endpoint cannot hold named prepared statements across transactions; the session time zone is
 * pinned to UTC so legacy `timestamp without time zone` columns are read and written as UTC.
 */
export function db(): Db {
  if (globalForDb.blogAdminDb) return globalForDb.blogAdminDb;
  const e = env();
  const sql = postgres(e.DATABASE_URL, {
    max: e.DATABASE_POOL_MAX,
    ssl: e.DATABASE_SSL === "require" ? "require" : false,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: { TimeZone: "UTC", application_name: "streamlineos-blog-admin", statement_timeout: 15_000 },
  });
  globalForDb.blogAdminSql = sql;
  globalForDb.blogAdminDb = drizzle(sql, { schema });
  return globalForDb.blogAdminDb;
}
