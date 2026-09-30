/**
 * Editorial capabilities. These are enforced on the server for every mutation, media operation,
 * revision read and preview read; the UI only mirrors them. Customer-organisation roles in
 * StreamlineOS never map here: access comes only from an explicit `blog_editors` row.
 */
export type EditorRole = "writer" | "publisher" | "admin";

export type Capability =
  | "post:create"
  | "post:edit-any"
  | "post:publish"
  | "post:reassign"
  | "media:upload"
  | "media:manage"
  | "taxonomy:manage"
  | "redirects:manage"
  | "editors:manage";

const BASE: Record<EditorRole, readonly Capability[]> = {
  writer: ["post:create", "media:upload"],
  publisher: ["post:create", "post:edit-any", "post:publish", "post:reassign", "media:upload", "media:manage", "redirects:manage"],
  admin: [
    "post:create", "post:edit-any", "post:publish", "post:reassign", "media:upload", "media:manage",
    "taxonomy:manage", "redirects:manage", "editors:manage",
  ],
};

export interface CapabilityPolicy {
  /** PRD: taxonomy management for publishers is configurable (PUBLISHERS_MANAGE_TAXONOMY). */
  publishersManageTaxonomy: boolean;
}

export function can(role: EditorRole, capability: Capability, policy: CapabilityPolicy): boolean {
  if (capability === "taxonomy:manage" && role === "publisher") return policy.publishersManageTaxonomy;
  return BASE[role].includes(capability);
}

/** Writers edit only the drafts assigned to them; publishers and administrators edit any post. */
export function canEditPost(editor: { id: string; role: EditorRole }, post: { ownerEditorId: string | null }, policy: CapabilityPolicy): boolean {
  return can(editor.role, "post:edit-any", policy) || post.ownerEditorId === editor.id;
}
