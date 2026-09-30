// Local stand-in for R2 so `pnpm dev` works without Cloudflare credentials. In memory, unsigned,
// path-style: set R2_ENDPOINT=http://127.0.0.1:9000, R2_FORCE_PATH_STYLE=true and
// MEDIA_PUBLIC_ORIGIN=http://127.0.0.1:9000/<R2_PUBLIC_BUCKET>. Never a production substitute.
import { startFakeS3 } from "../tests/support/fake-s3.ts";

const store = await startFakeS3(Number(process.env.PORT ?? 9000));
console.log(`dev object store on ${store.url} (objects are lost on exit)`);
