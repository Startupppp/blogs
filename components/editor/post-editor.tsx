"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { EditorState, MediaSummary } from "@/lib/server/blog/queries";
import { CTA_KEYS, CTA_LABELS } from "@/lib/content/cta";
import { slugify } from "@/lib/content/slug";
import { saveDraftAction } from "@/app/(admin)/posts/[postId]/actions";
import { MediaPicker } from "@/components/media/media-picker";
import { ConflictDialog, type ConflictDetail } from "./conflict-dialog";
import { PublishPanel } from "./publish-panel";
import { RichText } from "./rich-text";

type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

export interface Fields {
  title: string;
  slug: string;
  excerpt: string;
  standfirst: string;
  seoTitle: string;
  seoDescription: string;
  coverMediaId: string | null;
  coverAlt: string;
  coverCaption: string;
  socialMediaId: string | null;
  authorId: string | null;
  categoryId: string | null;
  tags: string;
  isFeatured: boolean;
  ctaKey: string | null;
}

const AUTOSAVE_IDLE_MS = 1500;
const backupKey = (postId: string) => `blog-admin:draft:${postId}`;
const noSubscribe = () => () => {};
/** What this browser held for a post when the page opened; later autosave backups are not "recovered". */
const backupsAtOpen = new Map<string, string | null>();
function backupAtOpen(key: string): string | null {
  if (!backupsAtOpen.has(key)) {
    let value: string | null = null;
    try {
      value = localStorage.getItem(key);
    } catch {
      /* storage unavailable */
    }
    backupsAtOpen.set(key, value);
  }
  return backupsAtOpen.get(key) ?? null;
}

function fieldsFrom(rev: EditorState["revision"]): Fields {
  return {
    title: rev.title, slug: rev.slug, excerpt: rev.excerpt, standfirst: rev.standfirst ?? "", seoTitle: rev.seoTitle ?? "",
    seoDescription: rev.seoDescription ?? "", coverMediaId: rev.coverMediaId, coverAlt: rev.coverAlt ?? "", coverCaption: rev.coverCaption ?? "",
    socialMediaId: rev.socialMediaId, authorId: rev.authorId, categoryId: rev.categoryId, tags: rev.tags.join(", "),
    isFeatured: rev.isFeatured, ctaKey: rev.ctaKey,
  };
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: React.ReactNode; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children}
      {error ? <p id={`${id}-error`} role="alert" className="text-sm text-danger">{error}</p> : hint ? <p id={`${id}-hint`} className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

const inputClass = (error?: string) => `min-h-11 w-full rounded-md border bg-surface px-3 py-2 text-sm ${error ? "border-danger" : "border-rule"}`;

function Counter({ value, advise }: { value: string; advise: number }) {
  return <span className={value.length > advise ? "text-warn" : ""}>{value.length}/{advise} suggested</span>;
}

export function PostEditor({ initial }: { initial: EditorState }) {
  const postId = initial.post.id;
  const [fields, setFields] = useState<Fields>(() => fieldsFrom(initial.revision));
  const [doc, setDoc] = useState<unknown>(initial.revision.doc);
  const [version, setVersion] = useState(initial.post.version);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [savedAt, setSavedAt] = useState<string>(initial.revision.updatedAt);
  const [message, setMessage] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<ConflictDetail | null>(null);
  const [media, setMedia] = useState<Record<string, MediaSummary>>(initial.media);
  const [picker, setPicker] = useState<null | { title: string; onPick: (m: MediaSummary) => void }>(null);
  const [backupDismissed, setBackupDismissed] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const saving = useRef(false);
  const pending = useRef(false);
  const latest = useRef({ fields, doc, version });
  useEffect(() => {
    latest.current = { fields, doc, version };
  }, [fields, doc, version]);

  const legacyImages = useMemo(() => (initial.revision.legacyHtml?.match(/<img\b/gi) ?? []).length, [initial.revision.legacyHtml]);

  // A draft kept in this browser from a save that never reached the server.
  const storedBackup = useSyncExternalStore(noSubscribe, () => backupAtOpen(backupKey(postId)), () => null);
  const backup = useMemo(() => {
    if (!storedBackup || backupDismissed) return null;
    try {
      const parsed = JSON.parse(storedBackup) as { fields: Fields; doc: unknown; at: string };
      return new Date(parsed.at) > new Date(initial.revision.updatedAt) ? parsed : null;
    } catch {
      return null;
    }
  }, [storedBackup, backupDismissed, initial.revision.updatedAt]);

  const markDirty = useCallback(() => {
    setSaveState((s) => (s === "conflict" ? s : "dirty"));
  }, []);

  useEffect(() => {
    if (saveState !== "dirty" && saveState !== "error") return;
    try {
      localStorage.setItem(backupKey(postId), JSON.stringify({ fields, doc, at: new Date().toISOString() }));
    } catch {
      /* storage unavailable: the server save is the only copy */
    }
  }, [fields, doc, saveState, postId]);

  const update = <K extends keyof Fields>(key: K, value: Fields[K]) => {
    setFields((f) => {
      const next = { ...f, [key]: value };
      latest.current = { ...latest.current, fields: next };
      return next;
    });
    setFieldErrors((e) => {
      const { [key]: _gone, ...rest } = e;
      return rest;
    });
    markDirty();
  };

  const save = useCallback(async (expectedVersion?: number) => {
    if (saving.current) {
      pending.current = true;
      return;
    }
    saving.current = true;
    setSaveState("saving");
    const { fields: f, doc: d, version: v } = latest.current;
    const result = await saveDraftAction({
      postId, expectedVersion: expectedVersion ?? v, title: f.title, slug: f.slug, excerpt: f.excerpt, standfirst: f.standfirst,
      doc: d, seoTitle: f.seoTitle, seoDescription: f.seoDescription, coverMediaId: f.coverMediaId, coverAlt: f.coverAlt,
      coverCaption: f.coverCaption, socialMediaId: f.socialMediaId, authorId: f.authorId, categoryId: f.categoryId,
      tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean), isFeatured: f.isFeatured, ctaKey: f.ctaKey,
    }).catch(() => null);
    saving.current = false;
    if (!result) {
      setSaveState("error");
      setMessage("Could not reach the server. Your changes are kept in this browser; saving will retry.");
    } else if (result.ok) {
      setVersion(result.data.version);
      setSavedAt(result.data.savedAt);
      setWarnings(result.data.warnings);
      setMessage(null);
      if (pending.current) {
        pending.current = false;
        setSaveState("dirty");
      } else {
        setSaveState("saved");
        try { localStorage.removeItem(backupKey(postId)); } catch { /* ignore */ }
      }
    } else if (result.code === "version_conflict") {
      setSaveState("conflict");
      setConflict(result.detail as ConflictDetail);
    } else {
      setSaveState("error");
      setMessage(result.message);
      setFieldErrors(result.fields);
    }
  }, [postId]);

  // Autosave after a short idle; transient failures retry on the next idle tick.
  useEffect(() => {
    if (saveState !== "dirty" && saveState !== "error") return;
    const t = setTimeout(() => void save(), saveState === "error" ? 8000 : AUTOSAVE_IDLE_MS);
    return () => clearTimeout(t);
  }, [saveState, fields, doc, save]);

  useEffect(() => {
    const unsaved = saveState !== "saved";
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!unsaved) return;
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveState]);

  const pick = (title: string, onPick: (m: MediaSummary) => void) => setPicker({ title, onPick: (m) => { setMedia((all) => ({ ...all, [m.id]: m })); onPick(m); setPicker(null); } });
  const cover = fields.coverMediaId ? media[fields.coverMediaId] : undefined;
  const social = fields.socialMediaId ? media[fields.socialMediaId] : undefined;
  const err = (key: string) => fieldErrors[key] ?? warnings[key];

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-6">
        <div aria-live="polite" className="flex flex-wrap items-center gap-3 text-sm">
          {/* The saved time is formatted in the viewer's locale, which the server cannot know. */}
          <span suppressHydrationWarning className={saveState === "error" || saveState === "conflict" ? "text-danger" : "text-muted"}>
            {saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Unsaved changes" : saveState === "conflict" ? "Not saved — someone else changed this post" : saveState === "error" ? "Not saved" : `Saved ${new Date(savedAt).toLocaleTimeString()}`}
          </span>
          {saveState === "error" ? <button type="button" onClick={() => void save()} className="underline">Retry now</button> : null}
          {message ? <span role="alert" className="text-danger">{message}</span> : null}
        </div>

        {backup ? (
          <div role="status" className="flex flex-wrap items-center gap-3 rounded-md bg-warn-soft px-4 py-3 text-sm text-warn">
            <span>This browser has unsaved changes from {new Date(backup.at).toLocaleString()}.</span>
            <button type="button" className="underline" onClick={() => { setFields(backup.fields); setDoc(backup.doc); latest.current = { ...latest.current, fields: backup.fields, doc: backup.doc }; setBackupDismissed(true); setEditorKey((k) => k + 1); markDirty(); }}>Restore them</button>
            <button type="button" className="underline" onClick={() => { try { localStorage.removeItem(backupKey(postId)); } catch { /* ignore */ } setBackupDismissed(true); }}>Discard</button>
          </div>
        ) : null}

        {initial.revision.legacyHtml ? (
          <div role="status" className="rounded-md bg-warn-soft px-4 py-3 text-sm text-warn">
            This post came from the old editor and has been converted. Check the body carefully before saving.
            {legacyImages > 0 ? ` ${legacyImages} image(s) from the old editor could not be converted; add them again from the media library.` : ""}
          </div>
        ) : null}

        <Field id="title" label="Title" error={fieldErrors.title}>
          <input id="title" value={fields.title} maxLength={256} onChange={(e) => update("title", e.target.value)} className={`${inputClass(fieldErrors.title)} font-serif text-2xl`} aria-invalid={Boolean(fieldErrors.title)} />
        </Field>

        <Field id="slug" label="URL" error={err("slug")} hint={<>Public address: /blogs/{fields.slug || slugify(fields.title) || "…"}. Changing it after publishing redirects the old address.</>}>
          <div className="flex gap-2">
            <span className="flex items-center text-sm text-muted">/blogs/</span>
            <input id="slug" value={fields.slug} maxLength={120} onChange={(e) => update("slug", e.target.value.toLowerCase())} className={inputClass(err("slug"))} aria-invalid={Boolean(err("slug"))} />
            <button type="button" onClick={() => update("slug", slugify(fields.title))} className="min-h-11 whitespace-nowrap rounded-md border border-rule px-3 text-sm hover:bg-sage">From title</button>
          </div>
        </Field>

        <Field id="standfirst" label="Standfirst (optional)" hint="One or two sentences shown under the headline.">
          <textarea id="standfirst" value={fields.standfirst} maxLength={600} rows={2} onChange={(e) => update("standfirst", e.target.value)} className={inputClass()} />
        </Field>

        <RichText
          key={editorKey}
          initialDoc={doc}
          legacyHtml={editorKey === 0 ? initial.revision.legacyHtml : null}
          error={fieldErrors.doc}
          onChange={(next) => { setDoc(next); latest.current.doc = next; markDirty(); }}
          onRequestImage={(insert) => pick("Insert an image", (m) => insert({ mediaId: m.id, alt: m.altDefault ?? "", src: m.preview?.src ?? null }))}
        />

        <Field id="excerpt" label="Excerpt" error={fieldErrors.excerpt} hint={<>Shown in listings and as the default search description. <Counter value={fields.excerpt} advise={160} /></>}>
          <textarea id="excerpt" value={fields.excerpt} maxLength={500} rows={3} onChange={(e) => update("excerpt", e.target.value)} className={inputClass(fieldErrors.excerpt)} aria-invalid={Boolean(fieldErrors.excerpt)} />
        </Field>
      </div>

      <aside className="space-y-6" aria-label="Post settings">
        <PublishPanel initial={initial} version={version} setVersion={setVersion} dirty={saveState !== "saved"} flush={save} onFieldErrors={setFieldErrors} />

        <section className="space-y-4 rounded-lg border border-rule bg-surface p-4">
          <h2 className="font-medium">Cover image</h2>
          {cover?.preview ? <img src={cover.preview.src} alt="" className="aspect-[16/9] w-full rounded object-cover" /> : <div className="flex aspect-[16/9] items-center justify-center rounded bg-sage text-sm text-muted">{cover ? `Image ${cover.status}` : "No cover image"}</div>}
          {fieldErrors.coverMediaId ? <p role="alert" className="text-sm text-danger">{fieldErrors.coverMediaId}</p> : null}
          <div className="flex gap-2">
            <button type="button" className="min-h-11 rounded-md border border-rule px-3 text-sm hover:bg-sage" onClick={() => pick("Choose a cover image", (m) => { update("coverMediaId", m.id); if (!fields.coverAlt && m.altDefault) update("coverAlt", m.altDefault); })}>
              {cover ? "Replace" : "Choose image"}
            </button>
            {cover ? <button type="button" className="min-h-11 rounded-md px-3 text-sm text-danger hover:bg-danger-soft" onClick={() => update("coverMediaId", null)}>Remove</button> : null}
          </div>
          <Field id="coverAlt" label="Cover alt text" error={fieldErrors.coverAlt} hint="Describe what the image shows.">
            <input id="coverAlt" value={fields.coverAlt} maxLength={300} onChange={(e) => update("coverAlt", e.target.value)} className={inputClass(fieldErrors.coverAlt)} aria-invalid={Boolean(fieldErrors.coverAlt)} />
          </Field>
          <Field id="coverCaption" label="Caption (optional)">
            <input id="coverCaption" value={fields.coverCaption} maxLength={500} onChange={(e) => update("coverCaption", e.target.value)} className={inputClass()} />
          </Field>
        </section>

        <section className="space-y-4 rounded-lg border border-rule bg-surface p-4">
          <h2 className="font-medium">Details</h2>
          <Field id="authorId" label="Author" error={fieldErrors.authorId}>
            <select id="authorId" value={fields.authorId ?? ""} onChange={(e) => update("authorId", e.target.value || null)} className={inputClass(fieldErrors.authorId)}>
              <option value="">Choose an author</option>
              {initial.authors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field id="categoryId" label="Primary category" error={fieldErrors.categoryId}>
            <select id="categoryId" value={fields.categoryId ?? ""} onChange={(e) => update("categoryId", e.target.value || null)} className={inputClass(fieldErrors.categoryId)}>
              <option value="">Choose a category</option>
              {initial.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field id="tags" label="Tags" hint="Comma separated. Stored as URL-safe tags.">
            <input id="tags" value={fields.tags} onChange={(e) => update("tags", e.target.value)} className={inputClass()} />
          </Field>
          <Field id="ctaKey" label="Product call to action">
            <select id="ctaKey" value={fields.ctaKey ?? ""} onChange={(e) => update("ctaKey", e.target.value || null)} className={inputClass()}>
              <option value="">None</option>
              {CTA_KEYS.map((k) => <option key={k} value={k}>{CTA_LABELS[k]}</option>)}
            </select>
          </Field>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={fields.isFeatured} onChange={(e) => update("isFeatured", e.target.checked)} className="size-4" />
            Feature on the journal homepage
          </label>
        </section>

        <section className="space-y-4 rounded-lg border border-rule bg-surface p-4">
          <h2 className="font-medium">Search and sharing</h2>
          <Field id="seoTitle" label="Search title" hint={<>Empty uses the title. <Counter value={fields.seoTitle || fields.title} advise={60} /></>}>
            <input id="seoTitle" value={fields.seoTitle} maxLength={256} onChange={(e) => update("seoTitle", e.target.value)} className={inputClass()} />
          </Field>
          <Field id="seoDescription" label="Search description" hint={<>Empty uses the excerpt. <Counter value={fields.seoDescription || fields.excerpt} advise={160} /></>}>
            <textarea id="seoDescription" value={fields.seoDescription} maxLength={320} rows={3} onChange={(e) => update("seoDescription", e.target.value)} className={inputClass()} />
          </Field>
          <div className="space-y-2">
            <p className="text-sm font-medium">Social image</p>
            <p className="text-xs text-muted">{social ? social.fileName : "Uses a 1200×630 crop of the cover image."}</p>
            {fieldErrors.socialMediaId ? <p role="alert" className="text-sm text-danger">{fieldErrors.socialMediaId}</p> : null}
            <div className="flex gap-2">
              <button type="button" className="min-h-11 rounded-md border border-rule px-3 text-sm hover:bg-sage" onClick={() => pick("Choose a social image", (m) => update("socialMediaId", m.id))}>{social ? "Replace" : "Choose image"}</button>
              {social ? <button type="button" className="min-h-11 rounded-md px-3 text-sm text-danger hover:bg-danger-soft" onClick={() => update("socialMediaId", null)}>Use cover</button> : null}
            </div>
          </div>
        </section>
      </aside>

      <MediaPicker open={picker !== null} title={picker?.title} onClose={() => setPicker(null)} onSelect={(m) => picker?.onPick(m)} />
      <ConflictDialog
        detail={conflict}
        mine={{ title: fields.title, excerpt: fields.excerpt }}
        onKeepMine={() => { const v = conflict?.version; setConflict(null); if (v) { setVersion(v); latest.current.version = v; void save(v); } }}
        onLoadTheirs={() => { try { localStorage.removeItem(backupKey(postId)); } catch { /* ignore */ } window.location.reload(); }}
        onClose={() => setConflict(null)}
      />
    </div>
  );
}
