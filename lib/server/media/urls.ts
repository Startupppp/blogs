import type { CoverProjection, MediaVariant } from "../db/schema";
import type { RenderedMedia } from "@/lib/content/render";

type UrlFor = (variant: MediaVariant) => string;

const responsive = (variants: MediaVariant[], format: MediaVariant["format"]) =>
  variants.filter((v) => v.kind === "responsive" && v.format === format).sort((a, b) => a.width - b.width);

/** The fallback `src`: the largest JPEG up to 1200 px, else the largest JPEG. */
function fallback(variants: MediaVariant[]): MediaVariant | null {
  const jpegs = responsive(variants, "jpeg");
  return [...jpegs].reverse().find((v) => v.width <= 1200) ?? jpegs[jpegs.length - 1] ?? null;
}

export function renderedMedia(variants: MediaVariant[], urlFor: UrlFor): RenderedMedia | null {
  const src = fallback(variants);
  if (!src) return null;
  const webp = responsive(variants, "webp");
  return {
    src: urlFor(src),
    width: src.width,
    height: src.height,
    srcset: (webp.length ? webp : responsive(variants, "jpeg")).map((v) => `${urlFor(v)} ${v.width}w`).join(", "),
  };
}

export function coverProjection(
  variants: MediaVariant[],
  urlFor: UrlFor,
  meta: { alt: string; caption: string | null; credit: string | null },
): CoverProjection | null {
  const src = fallback(variants);
  if (!src) return null;
  return {
    src: urlFor(src),
    width: src.width,
    height: src.height,
    alt: meta.alt,
    caption: meta.caption,
    credit: meta.credit,
    sources: responsive(variants, "webp").map((v) => ({ src: urlFor(v), width: v.width, type: v.mime })),
  };
}

export function socialVariant(variants: MediaVariant[]): MediaVariant | null {
  return variants.find((v) => v.kind === "social") ?? null;
}

/** Authenticated preview URL for a private variant; served by app/api/media/[mediaId]/file. */
export function previewUrlFor(mediaId: string): UrlFor {
  return (v) => `/api/media/${mediaId}/file?variant=${encodeURIComponent(v.checksum)}`;
}

export function publicUrlFor(origin: string): UrlFor {
  return (v) => `${origin}/${v.publicKey}`;
}
