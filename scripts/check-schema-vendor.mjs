// Fails when a vendored backend migration in db/test-schema/ differs from the backend's copy, so
// the admin's database tests never run against a schema the backend does not actually create.
// `0000_blog_legacy.sql` is a hand-assembled excerpt of several backend migrations and is skipped.
//
//   BACKEND_DIR=../streamlineos-backend pnpm check:schema-vendor
//
// Exit 0: every vendored file matches. Exit 1: drift. Exit 2: backend checkout not found.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const backend = resolve(process.env.BACKEND_DIR ?? "../streamlineos-backend");
const migrations = join(backend, "migrations");
if (!existsSync(migrations)) {
  console.error(`check-schema-vendor: no backend migrations at ${migrations}; set BACKEND_DIR`);
  process.exit(2);
}

let drift = 0;
for (const file of readdirSync("db/test-schema").filter((f) => f.endsWith(".sql") && !f.startsWith("0000_"))) {
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
process.exit(drift ? 1 : 0);
