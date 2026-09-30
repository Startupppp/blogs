import { z } from "zod";
import { CTA_KEYS } from "@/lib/content/cta";

const optionalText = (max: number) => z.string().trim().max(max).transform((v) => (v.length ? v : null)).nullable();
const uuid = z.string().uuid();

/** Everything the editor may change on a draft. Identity, status and ownership are never inputs. */
export const draftInputSchema = z.object({
  postId: uuid,
  expectedVersion: z.number().int().min(1),
  title: z.string().trim().max(256),
  slug: z.string().trim().max(256),
  excerpt: z.string().trim().max(500),
  standfirst: optionalText(600),
  doc: z.unknown(),
  seoTitle: optionalText(256),
  seoDescription: optionalText(320),
  coverMediaId: uuid.nullable(),
  coverAlt: optionalText(300),
  coverCaption: optionalText(500),
  socialMediaId: uuid.nullable(),
  authorId: uuid.nullable(),
  categoryId: uuid.nullable(),
  tags: z.array(z.string().max(64)).max(12),
  isFeatured: z.boolean(),
  ctaKey: z.enum(CTA_KEYS).nullable(),
}).strict();

export type DraftInput = z.infer<typeof draftInputSchema>;

export const versionedPostSchema = z.object({ postId: uuid, expectedVersion: z.number().int().min(1) }).strict();
