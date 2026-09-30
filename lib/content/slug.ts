/**
 * Route words under `/blogs/` that an article slug must never shadow. Keep in step with the public
 * site's route folders under `app/(public)/blogs/(site)/`.
 */
export const RESERVED_SLUGS = new Set([
  "archive",
  "category",
  "author",
  "tag",
  "search",
  "preview",
  "editorial-policy",
  "rss",
  "rss-xml",
  "feed",
  "page",
  "admin",
]);

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 120;

/**
 * Deterministic slug: Unicode is decomposed and stripped of diacritics, then anything outside
 * [a-z0-9] collapses to single hyphens. The same input always yields the same slug.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

export type SlugProblem = "empty" | "format" | "reserved" | "too-long";

export function checkSlug(slug: string): SlugProblem | null {
  if (!slug) return "empty";
  if (slug.length > MAX_SLUG_LENGTH) return "too-long";
  if (!SLUG_PATTERN.test(slug)) return "format";
  if (RESERVED_SLUGS.has(slug)) return "reserved";
  return null;
}

/** A usable alternative for a reserved or taken slug. */
export function suggestSlug(slug: string, taken: (candidate: string) => boolean = () => false): string {
  const base = RESERVED_SLUGS.has(slug) ? `${slug}-guide` : slug;
  if (!taken(base) && !RESERVED_SLUGS.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Tags are stored as slugs so `/blogs/tag/<tag>` is always a valid, canonical URL. */
export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map(slugify).filter((t) => t.length > 0 && t.length <= 64))].slice(0, 12);
}
