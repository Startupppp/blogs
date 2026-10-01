// Fails when the vendored shared schema in db/test-schema/ no longer describes what the backend
// actually creates, so the admin's database tests never pass against a schema that does not exist.
//
// Two checks:
//   1. Byte comparison for every vendored backend migration (file name must match upstream).
//   2. Column coverage for `0000_blog_legacy.sql`, which is a hand-assembled excerpt of several
//      backend migrations and therefore has no single upstream file to compare against. Every
//      column the backend's Drizzle schema declares for a blog table must exist somewhere in the
//      vendored SQL, so a backend column added or renamed outside a vendored migration is caught.
//
//   BACKEND_DIR=../streamlineos-backend pnpm check:schema-vendor
//
// Exit 0: vendored schema matches. Exit 1: drift. Exit 2: backend checkout not found.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const backend = resolve(process.env.BACKEND_DIR ?? "../streamlineos-backend");
const migrations = join(backend, "migrations");
if (!existsSync(migrations)) {
  console.error(`check-schema-vendor: no backend migrations at ${migrations}; set BACKEND_DIR`);
  process.exit(2);
}
const schemaFile = join(backend, "src/db/schema/blog/blog.ts");
if (!existsSync(schemaFile)) {
  console.error(`check-schema-vendor: no backend blog schema at ${schemaFile}; set BACKEND_DIR`);
  process.exit(2);
}

let drift = 0;

// --- 1. vendored migrations are byte-identical to the backend's copies ------------------------
const vendored = readdirSync("db/test-schema").filter((f) => f.endsWith(".sql"));
for (const file of vendored.filter((f) => !f.startsWith("0000_"))) {
  const upstream = join(migrations, file);
  if (!existsSync(upstream)) {
    console.error(`MISSING  ${file} is not in ${migrations}`);
    drift++;
  } else if (readFileSync(upstream, "utf8") !== readFileSync(join("db/test-schema", file), "utf8")) {
    console.error(`DRIFT    ${file} differs from the backend copy; re-copy it`);
    drift++;
  } else {
    console.log(`ok       ${file}`);
  }
}

// --- 2. every backend blog column exists in the vendored SQL -----------------------------------
/** Columns the backend's Drizzle schema declares, as `table -> Set(db column name)`. */
function backendColumns(source) {
  const tables = new Map();
  // pgTable("blog_posts", { ... }) — take the text up to the next `export const`, which is enough
  // to cover the column block and the optional index callback that follows it.
  const blocks = source.split(/export const /).slice(1);
  for (const block of blocks) {
    const name = /pgTable\(\s*\n?\s*"([a-z_]+)"/.exec(block)?.[1];
    if (!name) continue;
    const columns = new Set();
    for (const [, column] of block.matchAll(
      /^\s{2,4}[A-Za-z][A-Za-z0-9]*:\s*[A-Za-z][A-Za-z0-9]*\(\s*"([a-z_0-9]+)"/gm,
    )) {
      columns.add(column);
    }
    if (columns.size) tables.set(name, columns);
  }
  return tables;
}

/** Columns the vendored SQL creates, as `table -> Set(db column name)`. */
function vendoredColumns(files) {
  const TYPE = String.raw`(?:uuid|varchar|text|jsonb|boolean|integer|timestamp|timestamptz|smallint|bigint|"?blog_post_status"?)`;
  const tables = new Map();
  const add = (table, column) => {
    if (!tables.has(table)) tables.set(table, new Set());
    tables.get(table).add(column);
  };
  for (const file of files) {
    const sql = readFileSync(join("db/test-schema", file), "utf8");
    for (const [, table, body] of sql.matchAll(
      /CREATE TABLE(?: IF NOT EXISTS)?\s+"([a-z_]+)"\s*\(([\s\S]*?)\n?\);/gi,
    )) {
      for (const [, column] of body.matchAll(new RegExp(String.raw`"([a-z_0-9]+)"\s+${TYPE}\b`, "gi"))) {
        add(table, column);
      }
    }
    for (const [, table, body] of sql.matchAll(/ALTER TABLE\s+"([a-z_]+)"([\s\S]*?);/gi)) {
      for (const [, column] of body.matchAll(
        new RegExp(String.raw`ADD COLUMN(?: IF NOT EXISTS)?\s+"([a-z_0-9]+)"`, "gi"),
      )) {
        add(table, column);
      }
    }
  }
  return tables;
}

const declared = backendColumns(readFileSync(schemaFile, "utf8"));
const created = vendoredColumns(vendored);
for (const [table, columns] of declared) {
  const have = created.get(table);
  if (!have) {
    console.error(`MISSING  table "${table}" is in the backend schema but not in db/test-schema/`);
    drift++;
    continue;
  }
  const absent = [...columns].filter((c) => !have.has(c));
  if (absent.length) {
    console.error(`DRIFT    "${table}" is missing ${absent.map((c) => `"${c}"`).join(", ")} in db/test-schema/`);
    drift++;
  } else {
    console.log(`ok       ${table} (${columns.size} columns)`);
  }
}

process.exit(drift ? 1 : 0);
