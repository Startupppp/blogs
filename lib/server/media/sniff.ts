/** Formats accepted at launch. SVG, GIF, HEIC, AVIF uploads and anything animated are refused. */
export const ACCEPTED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export type AcceptedMime = (typeof ACCEPTED_MIME)[number];

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_PIXELS = 40_000_000;

export const EXTENSION: Record<AcceptedMime, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** The format the bytes actually are, from their signature — never from the name or the client. */
export function sniffImageMime(bytes: Uint8Array): AcceptedMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "image/png";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) return "image/webp";
  return null;
}

export function isAcceptedMime(value: string): value is AcceptedMime {
  return (ACCEPTED_MIME as readonly string[]).includes(value);
}
