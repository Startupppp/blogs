import type { ArticleDocument, BlockNode, InlineNode, TableCellNode } from "./document";
import { slugify } from "./slug";

/** How an image placement is drawn. `null` means the media is unknown or not ready. */
export interface RenderedMedia {
  src: string;
  width: number;
  height: number;
  srcset: string;
}

export type MediaResolver = (mediaId: string) => RenderedMedia | null;

export interface Heading {
  id: string;
  text: string;
  level: 2 | 3 | 4;
}

export interface RenderResult {
  html: string;
  text: string;
  headings: Heading[];
  mediaIds: string[];
  links: string[];
  wordCount: number;
  imagesMissingAlt: number;
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

const ARTICLE_SIZES = "(max-width: 768px) 100vw, 720px";

/**
 * Renders the canonical document to HTML. This is the ONLY producer of article HTML: the client
 * never sends HTML, and every text node and attribute is escaped here. Heading ids are derived from
 * the heading text and made unique, so the table of contents and anchors are stable across saves.
 */
export function renderDocument(doc: ArticleDocument, resolveMedia: MediaResolver): RenderResult {
  const used = new Set<string>();
  const headings: Heading[] = [];
  const mediaIds: string[] = [];
  const links: string[] = [];
  const textParts: string[] = [];
  let imagesMissingAlt = 0;

  const inlineText = (nodes: InlineNode[] | undefined) =>
    (nodes ?? []).map((n) => (n.type === "text" ? n.text : " ")).join("");

  const renderInline = (nodes: InlineNode[] | undefined): string =>
    (nodes ?? [])
      .map((node) => {
        if (node.type === "hardBreak") return "<br>";
        textParts.push(node.text);
        let out = escapeHtml(node.text);
        for (const mark of node.marks ?? []) {
          if (mark.type === "bold") out = `<strong>${out}</strong>`;
          else if (mark.type === "italic") out = `<em>${out}</em>`;
          else if (mark.type === "strike") out = `<s>${out}</s>`;
          else if (mark.type === "code") out = `<code>${out}</code>`;
          else {
            links.push(mark.attrs.href);
            const external = /^(https?:|mailto:)/i.test(mark.attrs.href);
            const rel = external ? ' rel="noopener noreferrer"' : "";
            out = `<a href="${escapeHtml(mark.attrs.href)}"${rel}>${out}</a>`;
          }
        }
        return out;
      })
      .join("");

  const uniqueId = (text: string) => {
    const base = slugify(text) || "section";
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };

  const renderCell = (cell: TableCellNode) => {
    const tag = cell.type === "tableHeader" ? "th" : "td";
    const span = [
      cell.attrs?.colspan && cell.attrs.colspan > 1 ? ` colspan="${cell.attrs.colspan}"` : "",
      cell.attrs?.rowspan && cell.attrs.rowspan > 1 ? ` rowspan="${cell.attrs.rowspan}"` : "",
      tag === "th" ? ' scope="col"' : "",
    ].join("");
    return `<${tag}${span}>${renderBlocks(cell.content)}</${tag}>`;
  };

  const renderBlock = (node: BlockNode): string => {
    switch (node.type) {
      case "paragraph": {
        const inner = renderInline(node.content);
        textParts.push("\n");
        return inner ? `<p>${inner}</p>` : "";
      }
      case "heading": {
        const text = inlineText(node.content).trim();
        const inner = renderInline(node.content);
        textParts.push("\n");
        if (!text) return "";
        const id = uniqueId(text);
        headings.push({ id, text, level: node.attrs.level });
        return `<h${node.attrs.level} id="${id}">${inner}</h${node.attrs.level}>`;
      }
      case "blockquote":
        return `<blockquote>${renderBlocks(node.content)}</blockquote>`;
      case "callout":
        return `<aside class="callout" data-tone="${node.attrs.tone}">${renderBlocks(node.content)}</aside>`;
      case "bulletList":
        return `<ul>${node.content.map((li) => `<li>${renderBlocks(li.content)}</li>`).join("")}</ul>`;
      case "orderedList": {
        const start = node.attrs?.start && node.attrs.start !== 1 ? ` start="${node.attrs.start}"` : "";
        return `<ol${start}>${node.content.map((li) => `<li>${renderBlocks(li.content)}</li>`).join("")}</ol>`;
      }
      case "codeBlock": {
        const code = (node.content ?? []).map((t) => t.text).join("");
        textParts.push(code, "\n");
        const lang = node.attrs?.language ? ` data-language="${escapeHtml(node.attrs.language)}"` : "";
        return `<pre${lang}><code>${escapeHtml(code)}</code></pre>`;
      }
      case "horizontalRule":
        return "<hr>";
      case "image": {
        mediaIds.push(node.attrs.mediaId);
        const alt = node.attrs.alt.trim();
        if (!alt) imagesMissingAlt++;
        const media = resolveMedia(node.attrs.mediaId);
        if (!media) return "";
        const caption = node.attrs.caption?.trim();
        const img =
          `<img src="${escapeHtml(media.src)}" srcset="${escapeHtml(media.srcset)}" sizes="${ARTICLE_SIZES}"` +
          ` width="${media.width}" height="${media.height}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`;
        return `<figure>${img}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>`;
      }
      case "table":
        return `<div class="table-scroll" role="region" aria-label="Table" tabindex="0"><table><tbody>${node.content
          .map((row) => `<tr>${row.content.map(renderCell).join("")}</tr>`)
          .join("")}</tbody></table></div>`;
    }
  };

  const renderBlocks = (nodes: BlockNode[]): string => nodes.map(renderBlock).join("");

  const html = renderBlocks(doc.content);
  const text = textParts.join(" ").replace(/\s+/g, " ").trim();
  return {
    html,
    text,
    headings,
    mediaIds: [...new Set(mediaIds)],
    links: [...new Set(links)],
    wordCount: text ? text.split(" ").length : 0,
    imagesMissingAlt,
  };
}

/** 225 words a minute, rounded up, never below one minute (PUB-09). */
export function readingTimeMinutes(wordCount: number): number {
  return Math.max(1, Math.ceil(wordCount / 225));
}
