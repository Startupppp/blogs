import "server-only";
import { createHash } from "node:crypto";
import sharp, { type Sharp } from "sharp";
import type { MediaVariant } from "../db/schema";
import { MAX_PIXELS } from "./sniff";

export const RESPONSIVE_WIDTHS = [480, 768, 1200, 1600] as const;
export const SOCIAL_SIZE = { width: 1200, height: 630 } as const;

export interface EncodedVariant extends Omit<MediaVariant, "privateKey" | "publicKey"> {
  bytes: number;
  data: Buffer;
}

export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Delivery budgets from the brief: listing sizes under 150 KB, hero sizes under 300 KB. */
function budgetFor(width: number): number {
  return width <= 768 ? 150 * 1024 : 300 * 1024;
}

async function encode(pipeline: Sharp, format: "webp" | "jpeg", width: number): Promise<Buffer> {
  let quality = format === "webp" ? 80 : 82;
  let out = await (format === "webp" ? pipeline.clone().webp({ quality, effort: 4 }) : pipeline.clone().jpeg({ quality, mozjpeg: true })).toBuffer();
  // Step quality down while over budget, but never below 55: quality wins over the budget.
  while (out.byteLength > budgetFor(width) && quality > 55) {
    quality -= 9;
    out = await (format === "webp" ? pipeline.clone().webp({ quality, effort: 4 }) : pipeline.clone().jpeg({ quality, mozjpeg: true })).toBuffer();
  }
  return out;
}

/**
 * Produces the responsive WebP + JPEG widths and the 1200x630 social crop from verified bytes.
 * `rotate()` applies the EXIF orientation; sharp drops EXIF, XMP, ICC-location and GPS metadata
 * from output by default, so no camera or location data reaches a public variant. Widths never
 * upscale; a small source yields its own width only.
 */
export async function encodeVariants(source: Buffer, focal: { x: number; y: number }): Promise<EncodedVariant[]> {
  const base = sharp(source, { limitInputPixels: MAX_PIXELS, failOn: "error" }).rotate();
  const meta = await sharp(source, { limitInputPixels: MAX_PIXELS }).metadata();
  const width = meta.autoOrient?.width ?? meta.width ?? 0;
  const height = meta.autoOrient?.height ?? meta.height ?? 0;
  if (!width || !height) throw new Error("image has no dimensions");

  const widths = RESPONSIVE_WIDTHS.filter((w) => w <= width);
  if (widths.length === 0) widths.push(width as (typeof RESPONSIVE_WIDTHS)[number]);

  const out: EncodedVariant[] = [];
  for (const w of widths) {
    const resized = base.clone().resize({ width: w, withoutEnlargement: true });
    const h = Math.round((height * w) / width);
    for (const format of ["webp", "jpeg"] as const) {
      const data = await encode(resized, format, w);
      out.push({ kind: "responsive", width: w, height: h, format, mime: `image/${format}`, bytes: data.byteLength, checksum: sha256(data), data });
    }
  }

  // Social card: scale to cover 1200x630, then cut around the focal point.
  const scale = Math.max(SOCIAL_SIZE.width / width, SOCIAL_SIZE.height / height);
  const rw = Math.ceil(width * scale);
  const rh = Math.ceil(height * scale);
  const left = Math.min(Math.max(Math.round(focal.x * rw - SOCIAL_SIZE.width / 2), 0), rw - SOCIAL_SIZE.width);
  const top = Math.min(Math.max(Math.round(focal.y * rh - SOCIAL_SIZE.height / 2), 0), rh - SOCIAL_SIZE.height);
  const social = await base.clone()
    .resize({ width: rw, height: rh, fit: "fill" })
    .extract({ left, top, width: SOCIAL_SIZE.width, height: SOCIAL_SIZE.height })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  out.push({ kind: "social", ...SOCIAL_SIZE, format: "jpeg", mime: "image/jpeg", bytes: social.byteLength, checksum: sha256(social), data: social });
  return out;
}

/** Decodes enough to reject what must never be processed: animation, excess pixels, corrupt data. */
export async function inspectImage(bytes: Buffer): Promise<{ width: number; height: number; format: string }> {
  const meta = await sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: true, failOn: "error" }).metadata();
  if ((meta.pages ?? 1) > 1) throw new Error("Animated images are not supported.");
  const width = meta.autoOrient?.width ?? meta.width ?? 0;
  const height = meta.autoOrient?.height ?? meta.height ?? 0;
  if (!width || !height) throw new Error("The image has no dimensions.");
  if (width * height > MAX_PIXELS) throw new Error("The image is larger than 40 megapixels.");
  // Force a full decode: a truncated or malformed file fails here rather than in a later job.
  await sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error" }).stats();
  return { width, height, format: meta.format ?? "unknown" };
}
