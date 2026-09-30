"use client";

import { EditorContent, useEditor, useEditorState, type Editor as TiptapEditor } from "@tiptap/react";
import { useState } from "react";
import { isSafeHref } from "@/lib/content/document";
import { articleExtensions, editorDocument } from "./extensions";

interface Props {
  initialDoc: unknown;
  /** Old-editor HTML to convert on load, when the stored document predates this editor. */
  legacyHtml: string | null;
  onChange: (doc: unknown) => void;
  onRequestImage: (insert: (media: { mediaId: string; alt: string; src: string | null }) => void) => void;
  error?: string;
}

function ToolButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active} disabled={disabled} onClick={onClick}
      className={`min-h-9 min-w-9 rounded px-2 text-sm ${active ? "bg-ink text-paper" : "hover:bg-sage"} disabled:opacity-40`}>
      {children}
    </button>
  );
}

function Toolbar({ editor, onRequestImage }: { editor: TiptapEditor; onRequestImage: Props["onRequestImage"] }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState("");
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h2: e.isActive("heading", { level: 2 }), h3: e.isActive("heading", { level: 3 }), h4: e.isActive("heading", { level: 4 }),
      bold: e.isActive("bold"), italic: e.isActive("italic"), strike: e.isActive("strike"), code: e.isActive("code"),
      link: e.isActive("link"), bullet: e.isActive("bulletList"), ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"), callout: e.isActive("callout"), codeBlock: e.isActive("codeBlock"), table: e.isActive("table"),
      image: e.isActive("image"), imageAttrs: e.getAttributes("image"),
      canUndo: e.can().undo(), canRedo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();
  const applyLink = () => {
    const value = href.trim();
    if (!value) chain().extendMarkRange("link").unsetLink().run();
    else if (isSafeHref(value)) chain().extendMarkRange("link").setLink({ href: value }).run();
    setLinkOpen(false);
  };

  return (
    <div className="sticky top-0 z-10 border-b border-rule bg-surface">
      <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 p-1.5">
        <ToolButton label="Heading 2" active={state.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()}>H2</ToolButton>
        <ToolButton label="Heading 3" active={state.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()}>H3</ToolButton>
        <ToolButton label="Heading 4" active={state.h4} onClick={() => chain().toggleHeading({ level: 4 }).run()}>H4</ToolButton>
        <span className="mx-1 h-5 w-px bg-rule" aria-hidden />
        <ToolButton label="Bold" active={state.bold} onClick={() => chain().toggleBold().run()}><b>B</b></ToolButton>
        <ToolButton label="Italic" active={state.italic} onClick={() => chain().toggleItalic().run()}><i>I</i></ToolButton>
        <ToolButton label="Strikethrough" active={state.strike} onClick={() => chain().toggleStrike().run()}><s>S</s></ToolButton>
        <ToolButton label="Inline code" active={state.code} onClick={() => chain().toggleCode().run()}>{"<>"}</ToolButton>
        <ToolButton label="Link" active={state.link} onClick={() => { setHref(editor.getAttributes("link").href ?? ""); setLinkOpen((o) => !o); }}>Link</ToolButton>
        <span className="mx-1 h-5 w-px bg-rule" aria-hidden />
        <ToolButton label="Bulleted list" active={state.bullet} onClick={() => chain().toggleBulletList().run()}>• List</ToolButton>
        <ToolButton label="Numbered list" active={state.ordered} onClick={() => chain().toggleOrderedList().run()}>1. List</ToolButton>
        <ToolButton label="Quote" active={state.quote} onClick={() => chain().toggleBlockquote().run()}>Quote</ToolButton>
        <ToolButton label="Callout" active={state.callout} onClick={() => chain().toggleCallout("info").run()}>Callout</ToolButton>
        <ToolButton label="Code block" active={state.codeBlock} onClick={() => chain().toggleCodeBlock().run()}>Code</ToolButton>
        <ToolButton label="Divider" onClick={() => chain().setHorizontalRule().run()}>―</ToolButton>
        <ToolButton label="Insert table" active={state.table} onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>Table</ToolButton>
        <ToolButton label="Insert image" onClick={() => onRequestImage((m) => chain().insertArticleImage({ mediaId: m.mediaId, alt: m.alt, src: m.src, caption: null }).run())}>Image</ToolButton>
        <span className="mx-1 h-5 w-px bg-rule" aria-hidden />
        <ToolButton label="Undo" disabled={!state.canUndo} onClick={() => chain().undo().run()}>↶</ToolButton>
        <ToolButton label="Redo" disabled={!state.canRedo} onClick={() => chain().redo().run()}>↷</ToolButton>
      </div>

      {linkOpen ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-rule p-2">
          <label htmlFor="link-href" className="text-sm">Link URL</label>
          <input id="link-href" autoFocus value={href} onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } if (e.key === "Escape") setLinkOpen(false); }}
            placeholder="https://… or /blogs/…" className="min-h-9 min-w-72 flex-1 rounded border border-rule px-2 text-sm" aria-invalid={href.trim() !== "" && !isSafeHref(href)} />
          <button type="button" onClick={applyLink} className="min-h-9 rounded bg-ink px-3 text-sm text-paper">{href.trim() ? "Apply" : "Remove link"}</button>
          {href.trim() && !isSafeHref(href) ? <span role="alert" className="text-sm text-danger">Use https, http, mailto, a /path or #anchor.</span> : null}
        </div>
      ) : null}

      {state.callout ? (
        <div className="flex items-center gap-2 border-t border-rule p-2 text-sm">
          <span>Callout tone</span>
          {(["info", "tip", "warning"] as const).map((tone) => (
            <button key={tone} type="button" className="min-h-9 rounded px-2 capitalize hover:bg-sage" onClick={() => chain().updateAttributes("callout", { tone }).run()}>{tone}</button>
          ))}
        </div>
      ) : null}

      {state.image ? (
        <div className="grid gap-2 border-t border-rule p-2 text-sm sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span>Alt text <span className="text-muted">(leave empty only if decorative)</span></span>
            <input value={String(state.imageAttrs.alt ?? "")} maxLength={300} onChange={(e) => editor.chain().updateAttributes("image", { alt: e.target.value }).run()} className="min-h-9 rounded border border-rule px-2" />
          </label>
          <label className="flex flex-col gap-1">
            <span>Caption</span>
            <input value={String(state.imageAttrs.caption ?? "")} maxLength={500} onChange={(e) => editor.chain().updateAttributes("image", { caption: e.target.value || null }).run()} className="min-h-9 rounded border border-rule px-2" />
          </label>
        </div>
      ) : null}

      {state.table ? (
        <div className="flex flex-wrap gap-1 border-t border-rule p-2 text-sm">
          <button type="button" className="rounded px-2 py-1 hover:bg-sage" onClick={() => chain().addRowAfter().run()}>Add row</button>
          <button type="button" className="rounded px-2 py-1 hover:bg-sage" onClick={() => chain().addColumnAfter().run()}>Add column</button>
          <button type="button" className="rounded px-2 py-1 hover:bg-sage" onClick={() => chain().deleteRow().run()}>Delete row</button>
          <button type="button" className="rounded px-2 py-1 hover:bg-sage" onClick={() => chain().deleteColumn().run()}>Delete column</button>
          <button type="button" className="rounded px-2 py-1 text-danger hover:bg-danger-soft" onClick={() => chain().deleteTable().run()}>Delete table</button>
        </div>
      ) : null}
    </div>
  );
}

export function RichText({ initialDoc, legacyHtml, onChange, onRequestImage, error }: Props) {
  const editor = useEditor({
    extensions: articleExtensions,
    // Old-editor HTML is parsed by the browser into THIS schema; anything the schema lacks is dropped,
    // and the server validates the result before storing it.
    content: legacyHtml ?? (initialDoc as object),
    immediatelyRender: false,
    editorProps: { attributes: { class: "article mx-auto px-6 py-8", "aria-label": "Article body", "aria-multiline": "true", role: "textbox" } },
    onUpdate: ({ editor: e }) => onChange(editorDocument(e)),
    onCreate: ({ editor: e }) => { if (legacyHtml) onChange(editorDocument(e)); },
  });
  if (!editor) return <div className="min-h-96 rounded-lg border border-rule bg-surface" aria-busy="true" />;
  return (
    <div className={`overflow-hidden rounded-lg border bg-surface ${error ? "border-danger" : "border-rule"}`}>
      <Toolbar editor={editor} onRequestImage={onRequestImage} />
      <EditorContent editor={editor} />
      {error ? <p role="alert" className="border-t border-danger bg-danger-soft px-4 py-2 text-sm text-danger">{error}</p> : null}
    </div>
  );
}
