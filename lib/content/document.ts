import { z } from "zod";

/**
 * The canonical article document: an allowlisted subset of the Tiptap/ProseMirror JSON the editor
 * produces. Parsing strips every attribute that is not listed here, so what is stored is only what
 * the renderer understands. Anything outside the allowlist is rejected, never passed through.
 *
 * Bump DOCUMENT_SCHEMA_VERSION when a node or attribute is added, and keep the public site's
 * sanitizer allowlist (streamlineos-frontend `lib/blog/sanitize.ts`) in step with RENDERER_VERSION.
 */
export const DOCUMENT_SCHEMA_VERSION = 1;
export const RENDERER_VERSION = 1;

const MAX_TEXT = 20_000;
const MAX_NODES_PER_LEVEL = 2_000;

const SAFE_SCHEMES = ["https:", "http:", "mailto:"];

/** Accepts absolute http(s)/mailto URLs, site-relative paths and in-page anchors. */
export function isSafeHref(href: string): boolean {
  const value = href.trim();
  if (value.length === 0 || value.length > 2_000) return false;
  if (/[\u0000-\u001f\s]/.test(value)) return false;
  if (value.startsWith("#")) return /^#[A-Za-z0-9_-]+$/.test(value);
  if (value.startsWith("/")) return !value.startsWith("//") && !value.startsWith("/\\");
  try {
    return SAFE_SCHEMES.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const markSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bold") }),
  z.object({ type: z.literal("italic") }),
  z.object({ type: z.literal("strike") }),
  z.object({ type: z.literal("code") }),
  z.object({
    type: z.literal("link"),
    attrs: z.object({ href: z.string().refine(isSafeHref, "Link must be https, http, mailto, a site path or an #anchor") }),
  }),
]);

const textSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(MAX_TEXT),
  marks: z.array(markSchema).max(5).optional(),
});

const inlineSchema = z.discriminatedUnion("type", [textSchema, z.object({ type: z.literal("hardBreak") })]);
const inlineContent = z.array(inlineSchema).max(MAX_NODES_PER_LEVEL).optional();

const uuid = z.string().uuid();

export type InlineNode = z.infer<typeof inlineSchema>;
export type BlockNode =
  | { type: "paragraph"; content?: InlineNode[] }
  | { type: "heading"; attrs: { level: 2 | 3 | 4 }; content?: InlineNode[] }
  | { type: "blockquote"; content: BlockNode[] }
  | { type: "callout"; attrs: { tone: "info" | "tip" | "warning" }; content: BlockNode[] }
  | { type: "bulletList"; content: ListItemNode[] }
  | { type: "orderedList"; attrs?: { start?: number }; content: ListItemNode[] }
  | { type: "codeBlock"; attrs?: { language?: string | null }; content?: { type: "text"; text: string }[] }
  | { type: "horizontalRule" }
  | { type: "image"; attrs: { mediaId: string; alt: string; caption?: string | null } }
  | { type: "table"; content: TableRowNode[] };
export type ListItemNode = { type: "listItem"; content: BlockNode[] };
export type TableCellNode = {
  type: "tableCell" | "tableHeader";
  attrs?: { colspan?: number; rowspan?: number };
  content: BlockNode[];
};
export type TableRowNode = { type: "tableRow"; content: TableCellNode[] };
export type ArticleDocument = { type: "doc"; content: BlockNode[] };

const blockSchema: z.ZodType<BlockNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("paragraph"), content: inlineContent }),
    z.object({
      type: z.literal("heading"),
      attrs: z.object({ level: z.union([z.literal(2), z.literal(3), z.literal(4)]) }),
      content: inlineContent,
    }),
    z.object({ type: z.literal("blockquote"), content: z.array(blockSchema).min(1).max(MAX_NODES_PER_LEVEL) }),
    z.object({
      type: z.literal("callout"),
      attrs: z.object({ tone: z.enum(["info", "tip", "warning"]) }),
      content: z.array(blockSchema).min(1).max(MAX_NODES_PER_LEVEL),
    }),
    z.object({ type: z.literal("bulletList"), content: z.array(listItemSchema).min(1).max(MAX_NODES_PER_LEVEL) }),
    z.object({
      type: z.literal("orderedList"),
      attrs: z.object({ start: z.number().int().min(0).max(100_000).optional() }).optional(),
      content: z.array(listItemSchema).min(1).max(MAX_NODES_PER_LEVEL),
    }),
    z.object({
      type: z.literal("codeBlock"),
      attrs: z.object({ language: z.string().regex(/^[a-z0-9+#-]{1,20}$/).nullable().optional() }).optional(),
      content: z.array(z.object({ type: z.literal("text"), text: z.string().max(MAX_TEXT) })).max(MAX_NODES_PER_LEVEL).optional(),
    }),
    z.object({ type: z.literal("horizontalRule") }),
    z.object({
      type: z.literal("image"),
      attrs: z.object({
        mediaId: uuid,
        alt: z.string().max(300),
        caption: z.string().max(500).nullable().optional(),
      }),
    }),
    z.object({ type: z.literal("table"), content: z.array(tableRowSchema).min(1).max(500) }),
  ]),
);

const listItemSchema: z.ZodType<ListItemNode> = z.lazy(() =>
  z.object({ type: z.literal("listItem"), content: z.array(blockSchema).min(1).max(MAX_NODES_PER_LEVEL) }),
);

const tableCellSchema: z.ZodType<TableCellNode> = z.lazy(() =>
  z.object({
    type: z.enum(["tableCell", "tableHeader"]),
    attrs: z.object({
      colspan: z.number().int().min(1).max(20).optional(),
      rowspan: z.number().int().min(1).max(100).optional(),
    }).optional(),
    content: z.array(blockSchema).min(1).max(50),
  }),
);

const tableRowSchema: z.ZodType<TableRowNode> = z.lazy(() =>
  z.object({ type: z.literal("tableRow"), content: z.array(tableCellSchema).min(1).max(30) }),
);

export const articleDocumentSchema: z.ZodType<ArticleDocument> = z.object({
  type: z.literal("doc"),
  content: z.array(blockSchema).max(MAX_NODES_PER_LEVEL),
});

export const EMPTY_DOCUMENT: ArticleDocument = { type: "doc", content: [{ type: "paragraph" }] };

/** Parses untrusted editor JSON into the canonical document, or reports where it failed. */
export function parseDocument(input: unknown) {
  return articleDocumentSchema.safeParse(input);
}
