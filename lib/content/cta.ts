/**
 * Contextual product calls to action. The admin stores only the key; the public site owns the
 * label and destination (streamlineos-frontend `lib/blog/cta.ts`). Every destination is an
 * existing StreamlineOS page, so an article can never link a CTA to an invented URL.
 */
export const CTA_KEYS = ["pricing", "contact", "about"] as const;
export type CtaKey = (typeof CTA_KEYS)[number];

export const CTA_LABELS: Record<CtaKey, string> = {
  pricing: "See plans and pricing (/pricing)",
  contact: "Talk to the team (/contact)",
  about: "How StreamlineOS works (/about)",
};
