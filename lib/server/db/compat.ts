import "server-only";
import { eq } from "drizzle-orm";
import type { Db } from "./client";
import { blogSchemaMeta } from "./schema";

/**
 * Shared-schema contract versions this build can write. `blog_schema_meta.version` is set by the
 * backend migration that last changed what the admin must write (1705 sets 2). A database outside
 * this list means the backend and admin are out of step, so every write is refused with 503 rather
 * than risk writing rows a public reader cannot handle.
 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [2];

export class SchemaIncompatibleError extends Error {
  constructor(readonly found: number | null) {
    super(`Shared blog schema version ${found ?? "missing"} is not supported by this admin build`);
  }
}

let verifiedUntil = 0;

export async function assertSchemaCompatible(database: Db, now = Date.now()): Promise<void> {
  if (now < verifiedUntil) return;
  const [row] = await database.select({ version: blogSchemaMeta.version }).from(blogSchemaMeta).where(eq(blogSchemaMeta.id, 1));
  const found = row?.version ?? null;
  if (found === null || !SUPPORTED_SCHEMA_VERSIONS.includes(found)) throw new SchemaIncompatibleError(found);
  verifiedUntil = now + 60_000;
}

export function resetSchemaCompatCache(): void {
  verifiedUntil = 0;
}
