import { Node, mergeAttributes } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { isSafeHref } from "@/lib/content/document";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    articleImage: {
      insertArticleImage: (attrs: { mediaId: string; alt: string; caption?: string | null; src: string | null }) => ReturnType;
    };
    callout: {
      toggleCallout: (tone: "info" | "tip" | "warning") => ReturnType;
    };
  }
}

/**
 * The editor's document as plain JSON. ProseMirror builds node attrs with a null prototype, and
 * React passes non-plain objects to a Server Action as opaque temporary references, so without
 * this every heading, image, callout and table reached the server as a function and the save
 * was refused.
 */
export function editorDocument(editor: { getJSON(): unknown }): unknown {
  return structuredClone(editor.getJSON());
}

/**
 * A figure that references library media by id. `src` is an editor-only preview URL: the server
 * strips it and renders the published image from the media record, never from the client.
 * Old-editor <img> tags carry no media id and are therefore not imported (see
 * docs/content-migration.md) — they must be re-added from the media library.
 */
export const ArticleImage = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      mediaId: { default: null, parseHTML: (el) => el.getAttribute("data-media-id"), renderHTML: (a) => ({ "data-media-id": a.mediaId }) },
      alt: { default: "", parseHTML: (el) => el.querySelector("img")?.getAttribute("alt") ?? "", renderHTML: () => ({}) },
      caption: { default: null, parseHTML: (el) => el.querySelector("figcaption")?.textContent ?? null, renderHTML: () => ({}) },
      src: { default: null, parseHTML: (el) => el.querySelector("img")?.getAttribute("src") ?? null, renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [{ tag: "figure[data-media-id]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const img = ["img", { src: node.attrs.src ?? "", alt: node.attrs.alt ?? "" }];
    return node.attrs.caption
      ? ["figure", mergeAttributes(HTMLAttributes), img, ["figcaption", {}, node.attrs.caption]]
      : ["figure", mergeAttributes(HTMLAttributes), img];
  },
  addCommands() {
    return {
      insertArticleImage: (attrs) => ({ commands }) => commands.insertContent({ type: this.name, attrs }),
    };
  },
});

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      tone: { default: "info", parseHTML: (el) => el.getAttribute("data-tone") ?? "info", renderHTML: (a) => ({ "data-tone": a.tone }) },
    };
  },
  parseHTML() {
    return [{ tag: "aside[data-tone]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["aside", mergeAttributes(HTMLAttributes, { class: "callout" }), 0];
  },
  addCommands() {
    return {
      toggleCallout: (tone) => ({ commands }) => commands.toggleWrap(this.name, { tone }),
    };
  },
});

/** Exactly the nodes and marks lib/content/document.ts accepts — nothing the server would refuse. */
export const articleExtensions = [
  StarterKit.configure({
    heading: { levels: [2, 3, 4] },
    underline: false,
    link: {
      openOnClick: false,
      autolink: true,
      defaultProtocol: "https",
      protocols: ["https", "http", "mailto"],
      isAllowedUri: (url) => isSafeHref(url),
    },
  }),
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  ArticleImage,
  Callout,
  Placeholder.configure({ placeholder: "Write the article. Use headings for sections; they build the table of contents." }),
];
