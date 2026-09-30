import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash } from "node:crypto";

/**
 * A controlled S3-compatible object store for tests: path-style PUT, GET, HEAD, DELETE and
 * CopyObject across buckets. It does not verify signatures — the real R2 check before production
 * sign-off does (see docs/verification.md). Objects live in memory for the test run.
 */
export interface FakeS3 {
  url: string;
  objects: Map<string, { body: Buffer; contentType: string; cacheControl: string | null }>;
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function startFakeS3(): Promise<FakeS3> {
  const objects: FakeS3["objects"] = new Map();
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = decodeURIComponent(url.pathname.slice(1));
    const body = await readBody(req);
    const existing = objects.get(path);
    const etag = (b: Buffer) => `"${createHash("md5").update(b).digest("hex")}"`;
    if (req.method === "PUT") {
      const copySource = req.headers["x-amz-copy-source"];
      if (typeof copySource === "string") {
        const source = objects.get(decodeURIComponent(copySource.replace(/^\//, "")));
        if (!source) { res.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>"); return; }
        objects.set(path, { body: source.body, contentType: String(req.headers["content-type"] ?? source.contentType), cacheControl: (req.headers["cache-control"] as string | undefined) ?? null });
        res.writeHead(200, { "content-type": "application/xml" }).end(`<CopyObjectResult><ETag>${etag(source.body)}</ETag><LastModified>${new Date().toISOString()}</LastModified></CopyObjectResult>`);
        return;
      }
      objects.set(path, { body, contentType: String(req.headers["content-type"] ?? "application/octet-stream"), cacheControl: (req.headers["cache-control"] as string | undefined) ?? null });
      res.writeHead(200, { etag: etag(body) }).end();
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      if (!existing) {
        res.writeHead(404, { "content-type": "application/xml" }).end(req.method === "GET" ? "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>" : undefined);
        return;
      }
      res.writeHead(200, { "content-type": existing.contentType, "content-length": existing.body.byteLength, etag: etag(existing.body), "last-modified": new Date().toUTCString() });
      res.end(req.method === "GET" ? existing.body : undefined);
      return;
    }
    if (req.method === "DELETE") {
      objects.delete(path);
      res.writeHead(204).end();
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, objects, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
