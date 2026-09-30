import { describe, expect, it } from "vitest";
import { isSafeHref, parseDocument, type ArticleDocument } from "@/lib/content/document";
import { readingTimeMinutes, renderDocument, type MediaResolver } from "@/lib/content/render";
import { checkSlug, normalizeTags, slugify, suggestSlug } from "@/lib/content/slug";

const MEDIA = "5b0b7a6e-3f55-4a57-9a53-1c7c0a0d2f11";
const resolver: MediaResolver = (id) =>
  id === MEDIA ? { src: "https://media.example.test/a-1200.webp", width: 1200, height: 800, srcset: "https://media.example.test/a-768.webp 768w" } : null;

function doc(content: unknown[]): unknown {
  return { type: "doc", content };
}

function parsed(input: unknown): ArticleDocument {
  const result = parseDocument(input);
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}

describe("slugs", () => {
  it("normalises Unicode, punctuation and case deterministically", () => {
    expect(slugify("  Crème Brûlée & Café: A Guide!  ")).toBe("creme-brulee-and-cafe-a-guide");
    expect(slugify("Crème Brûlée & Café: A Guide!")).toBe(slugify("Crème Brûlée & Café: A Guide!"));
  });

  it("caps very long titles without leaving a trailing hyphen", () => {
    const s = slugify(`${"word ".repeat(80)}end`);
    expect(s.length).toBeLessThanOrEqual(120);
    expect(s.endsWith("-")).toBe(false);
  });

  it("rejects reserved route words and suggests an alternative", () => {
    expect(checkSlug("archive")).toBe("reserved");
    expect(checkSlug("editorial-policy")).toBe("reserved");
    expect(checkSlug("an-onboarding-checklist")).toBeNull();
    expect(checkSlug("Bad Slug")).toBe("format");
    expect(suggestSlug("archive")).toBe("archive-guide");
    expect(suggestSlug("taken", (c) => c === "taken")).toBe("taken-2");
  });

  it("stores tags as unique slugs", () => {
    expect(normalizeTags(["Founder note", "founder-note", "  ", "HR"])).toEqual(["founder-note", "hr"]);
  });
});

describe("document validation", () => {
  it("rejects nodes outside the allowlist", () => {
    expect(parseDocument(doc([{ type: "iframe", attrs: { src: "https://evil.test" } }])).success).toBe(false);
    expect(parseDocument(doc([{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "highlight" }] }] }])).success).toBe(false);
  });

  it("rejects script and data URLs in links", () => {
    for (const href of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<script>", "//evil.test", " javascript:x", "vbscript:x"]) {
      expect(isSafeHref(href)).toBe(false);
    }
    for (const href of ["https://www.streamlineos.in/pricing", "/blogs/archive", "#setup", "mailto:hi@example.test"]) {
      expect(isSafeHref(href)).toBe(true);
    }
  });

  it("strips attributes the renderer does not understand", () => {
    const result = parsed(doc([{ type: "paragraph", attrs: { style: "x" }, content: [{ type: "text", text: "a", marks: [{ type: "link", attrs: { href: "/x", onclick: "alert(1)", target: "_blank" } }] }] }]));
    expect(JSON.stringify(result)).not.toContain("onclick");
    expect(JSON.stringify(result)).not.toContain("style");
  });

  it("rejects heading levels the article does not use", () => {
    expect(parseDocument(doc([{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "H" }] }])).success).toBe(false);
  });
});

describe("rendering", () => {
  it("escapes text so markup in content never becomes markup in HTML", () => {
    const out = renderDocument(parsed(doc([{ type: "paragraph", content: [{ type: "text", text: '<script>alert("x")</script>' }] }])), resolver);
    expect(out.html).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
  });

  it("gives duplicate headings stable unique anchors", () => {
    const h = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
    const out = renderDocument(parsed(doc([h("Setup"), h("Setup"), h("Setup")])), resolver);
    expect(out.headings.map((x) => x.id)).toEqual(["setup", "setup-2", "setup-3"]);
    expect(renderDocument(parsed(doc([h("Setup"), h("Setup"), h("Setup")])), resolver).html).toBe(out.html);
  });

  it("renders figures with dimensions, srcset and escaped alt and caption", () => {
    const out = renderDocument(parsed(doc([{ type: "image", attrs: { mediaId: MEDIA, alt: 'A "board"', caption: "<b>Plan</b>" } }])), resolver);
    expect(out.html).toContain('width="1200" height="800"');
    expect(out.html).toContain('alt="A &quot;board&quot;"');
    expect(out.html).toContain("<figcaption>&lt;b&gt;Plan&lt;/b&gt;</figcaption>");
    expect(out.mediaIds).toEqual([MEDIA]);
  });

  it("counts images without alt text so publishing can warn", () => {
    const out = renderDocument(parsed(doc([{ type: "image", attrs: { mediaId: MEDIA, alt: " " } }])), resolver);
    expect(out.imagesMissingAlt).toBe(1);
  });

  it("marks external links noopener and records every link for checking", () => {
    const out = renderDocument(parsed(doc([{ type: "paragraph", content: [
      { type: "text", text: "ext", marks: [{ type: "link", attrs: { href: "https://example.test" } }] },
      { type: "text", text: "int", marks: [{ type: "link", attrs: { href: "/blogs/other" } }] },
    ] }])), resolver);
    expect(out.html).toContain('<a href="https://example.test" rel="noopener noreferrer">ext</a>');
    expect(out.html).toContain('<a href="/blogs/other">int</a>');
    expect(out.links).toEqual(["https://example.test", "/blogs/other"]);
  });

  it("wraps tables in a labelled scroll region", () => {
    const out = renderDocument(parsed(doc([{ type: "table", content: [{ type: "tableRow", content: [
      { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Step" }] }] },
    ] }] }])), resolver);
    expect(out.html).toContain('<div class="table-scroll" role="region" aria-label="Table" tabindex="0">');
    expect(out.html).toContain('<th scope="col"><p>Step</p></th>');
  });

  it("derives reading time from rendered words with a one-minute floor", () => {
    expect(readingTimeMinutes(0)).toBe(1);
    expect(readingTimeMinutes(225)).toBe(1);
    expect(readingTimeMinutes(226)).toBe(2);
  });
});
