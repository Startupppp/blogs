import { eq } from "drizzle-orm";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/server/db/client";
import { blogMedia } from "@/lib/server/db/schema";
import type { Editor } from "@/lib/server/auth/editor";
import { ServiceError } from "@/lib/server/errors";
import { createUploadIntent, finalizeUpload } from "@/lib/server/media/upload";
import { promoteMedia } from "@/lib/server/media/promote";
import { headObject } from "@/lib/server/media/r2";
import { makeEditor, testJpeg, uploadImage } from "./fixtures";

let editor: Editor;
beforeAll(async () => {
  editor = await makeEditor("publisher");
});

async function media(id: string) {
  const [row] = await db().select().from(blogMedia).where(eq(blogMedia.id, id));
  if (!row) throw new Error("media missing");
  return row;
}

describe("media pipeline", () => {
  it("verifies, processes into responsive and social variants, and keeps everything private until promoted", async () => {
    const id = await uploadImage(editor, await testJpeg(2000, 1200));
    const m = await media(id);
    expect(m.status).toBe("ready");
    expect(m.width).toBe(2000);
    const responsive = m.variants.filter((v) => v.kind === "responsive");
    expect(responsive.map((v) => `${v.format}${v.width}`).sort()).toEqual(["jpeg1200", "jpeg1600", "jpeg480", "jpeg768", "webp1200", "webp1600", "webp480", "webp768"]);
    expect(m.variants.find((v) => v.kind === "social")).toMatchObject({ width: 1200, height: 630 });
    const first = m.variants[0];
    if (!first) throw new Error("no variants");
    expect(await headObject("blog-public", first.publicKey)).toBeNull();

    await promoteMedia(db(), [id]);
    expect(await headObject("blog-public", first.publicKey)).toMatchObject({ size: first.bytes });
    expect((await media(id)).promotedAt).not.toBeNull();
  });

  it("never upscales a small image", async () => {
    const id = await uploadImage(editor, await testJpeg(600, 400));
    const widths = new Set((await media(id)).variants.filter((v) => v.kind === "responsive").map((v) => v.width));
    expect([...widths]).toEqual([480]);
  });

  it("strips EXIF metadata from every variant", async () => {
    const withExif = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#335544" } })
      .withMetadata({ exif: { IFD0: { Copyright: "secret-location" } } }).jpeg().toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const id = await uploadImage(editor, withExif);
    const m = await media(id);
    const v = m.variants.find((x) => x.format === "jpeg");
    if (!v) throw new Error("no jpeg");
    const res = await fetch(`${process.env.R2_ENDPOINT}/blog-private/${v.privateKey}`);
    expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).exif).toBeUndefined();
  });

  it("rejects a file whose bytes are not the image type it claims", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const intent = await createUploadIntent(db(), editor, { fileName: "x.png", size: svg.byteLength, mime: "image/png" });
    await fetch(intent.uploadUrl, { method: "PUT", headers: intent.headers, body: new Uint8Array(svg) });
    const error = await finalizeUpload(db(), editor, intent.mediaId).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).status).toBe(422);
    expect((await media(intent.mediaId)).status).toBe("failed");
  });

  it("refuses types and sizes it will not accept before issuing an upload URL", async () => {
    await expect(createUploadIntent(db(), editor, { fileName: "x.svg", size: 10, mime: "image/svg+xml" })).rejects.toMatchObject({ status: 422 });
    await expect(createUploadIntent(db(), editor, { fileName: "x.jpg", size: 11 * 1024 * 1024, mime: "image/jpeg" })).rejects.toMatchObject({ status: 413 });
  });

  it("rejects an upload that grew past the limit after the intent", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 10, 0xff);
    const intent = await createUploadIntent(db(), editor, { fileName: "x.jpg", size: 100, mime: "image/jpeg" });
    await fetch(intent.uploadUrl, { method: "PUT", headers: intent.headers, body: new Uint8Array(big) });
    await expect(finalizeUpload(db(), editor, intent.mediaId)).rejects.toMatchObject({ status: 413 });
  });
});
