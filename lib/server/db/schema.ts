import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
  char,
} from "drizzle-orm/pg-core";

/**
 * Explicit mapping of the SHARED blog tables. The schema is owned by streamlineos-backend's
 * migrations (1705 and later); this file never drives a migration. `scripts/check-schema-compat.ts`
 * compares every column declared here with the live database, and `blog_schema_meta.version` is
 * checked at runtime (see ./compat.ts).
 *
 * `timestamp` without time zone columns are legacy (0000) and hold UTC clock time.
 */

export const blogPostStatus = pgEnum("blog_post_status", ["draft", "published", "archived"]);

export interface CoverProjection {
  src: string;
  width: number;
  height: number;
  alt: string;
  caption: string | null;
  credit: string | null;
  sources: { src: string; width: number; type: string }[];
}

export interface MediaVariant {
  /** `responsive` widths feed srcset; `social` is the 1200x630 card crop. */
  kind: "responsive" | "social";
  width: number;
  height: number;
  format: "webp" | "jpeg";
  mime: string;
  bytes: number;
  checksum: string;
  privateKey: string;
  publicKey: string;
}

export const blogSchemaMeta = pgTable("blog_schema_meta", {
  id: smallint("id").primaryKey(),
  version: integer("version").notNull(),
  publicationGeneration: bigint("publication_generation", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const blogEditors = pgTable("blog_editors", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 320 }).notNull(),
  subject: varchar("subject", { length: 255 }),
  name: varchar("name", { length: 200 }),
  role: varchar("role", { length: 16 }).$type<"writer" | "publisher" | "admin">().notNull(),
  authorId: uuid("author_id"),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const blogAuthors = pgTable("blog_authors", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  slug: varchar("slug", { length: 120 }).notNull(),
  email: varchar("email", { length: 320 }),
  avatar: text("avatar"),
  bio: text("bio"),
  role: varchar("role", { length: 100 }),
  twitter: varchar("twitter", { length: 100 }),
  linkedin: varchar("linkedin", { length: 200 }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const blogCategories = pgTable("blog_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull(),
  description: text("description"),
  color: varchar("color", { length: 7 }),
  seoTitle: varchar("seo_title", { length: 256 }),
  seoDescription: varchar("seo_description", { length: 320 }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const blogPosts = pgTable("blog_posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Published projection (legacy columns). For a never-published post they mirror the working
  // revision's title/slug/excerpt so the post is listable and its slug is reserved.
  title: varchar("title", { length: 256 }).notNull(),
  slug: varchar("slug", { length: 256 }).notNull(),
  excerpt: text("excerpt").notNull(),
  content: text("content").notNull(),
  contentJson: jsonb("content_json"),
  coverImage: text("cover_image").notNull(),
  categoryId: uuid("category_id"),
  authorId: uuid("author_id"),
  status: blogPostStatus("status").notNull(),
  isFeatured: boolean("is_featured").notNull(),
  readingTime: integer("reading_time"),
  metaTitle: varchar("meta_title", { length: 256 }),
  metaDescription: varchar("meta_description", { length: 320 }),
  publishedAt: timestamp("published_at"),
  tags: text("tags").array().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  workingRevisionId: uuid("working_revision_id"),
  publishedRevisionId: uuid("published_revision_id"),
  scheduledRevisionId: uuid("scheduled_revision_id"),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  scheduleVersion: integer("schedule_version").notNull(),
  version: integer("version").notNull(),
  modifiedAt: timestamp("modified_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  standfirst: text("standfirst"),
  searchText: text("search_text").notNull(),
  cover: jsonb("cover").$type<CoverProjection>(),
  socialImage: text("social_image"),
  ctaKey: varchar("cta_key", { length: 64 }),
  ownerEditorId: uuid("owner_editor_id"),
});

export const blogPostRevisions = pgTable("blog_post_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  postId: uuid("post_id").notNull(),
  seq: integer("seq").notNull(),
  schemaVersion: smallint("schema_version").notNull(),
  rendererVersion: smallint("renderer_version").notNull(),
  doc: jsonb("doc").notNull(),
  html: text("html").notNull(),
  searchText: text("search_text").notNull(),
  readingTime: integer("reading_time").notNull(),
  title: varchar("title", { length: 256 }).notNull(),
  slug: varchar("slug", { length: 256 }).notNull(),
  excerpt: text("excerpt").notNull(),
  standfirst: text("standfirst"),
  seoTitle: varchar("seo_title", { length: 256 }),
  seoDescription: varchar("seo_description", { length: 320 }),
  coverMediaId: uuid("cover_media_id"),
  coverAlt: text("cover_alt"),
  coverCaption: text("cover_caption"),
  socialMediaId: uuid("social_media_id"),
  legacyCoverUrl: text("legacy_cover_url"),
  authorId: uuid("author_id"),
  categoryId: uuid("category_id"),
  tags: text("tags").array().notNull(),
  isFeatured: boolean("is_featured").notNull(),
  ctaKey: varchar("cta_key", { length: 64 }),
  changeSummary: varchar("change_summary", { length: 500 }),
  frozenAt: timestamp("frozen_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const blogMedia = pgTable("blog_media", {
  id: uuid("id").primaryKey().defaultRandom(),
  privateKey: varchar("private_key", { length: 512 }).notNull(),
  status: varchar("status", { length: 16 }).$type<"pending" | "processing" | "ready" | "failed" | "deleted">().notNull(),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  declaredMime: varchar("declared_mime", { length: 64 }).notNull(),
  declaredBytes: bigint("declared_bytes", { mode: "number" }).notNull(),
  mime: varchar("mime", { length: 64 }),
  byteSize: bigint("byte_size", { mode: "number" }),
  checksumSha256: char("checksum_sha256", { length: 64 }),
  width: integer("width"),
  height: integer("height"),
  variants: jsonb("variants").$type<MediaVariant[]>().notNull(),
  altDefault: text("alt_default"),
  credit: varchar("credit", { length: 300 }),
  sourceUrl: varchar("source_url", { length: 1000 }),
  license: varchar("license", { length: 300 }),
  focalX: real("focal_x").notNull(),
  focalY: real("focal_y").notNull(),
  failureReason: varchar("failure_reason", { length: 300 }),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const blogRevisionMedia = pgTable(
  "blog_revision_media",
  {
    revisionId: uuid("revision_id").notNull(),
    mediaId: uuid("media_id").notNull(),
    placement: varchar("placement", { length: 16 }).$type<"cover" | "social" | "body">().notNull(),
  },
  (t) => [primaryKey({ columns: [t.revisionId, t.mediaId, t.placement] })],
);

export const blogRedirects = pgTable("blog_redirects", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourcePath: varchar("source_path", { length: 600 }).notNull(),
  targetPath: varchar("target_path", { length: 600 }),
  statusCode: smallint("status_code").notNull(),
  postId: uuid("post_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const blogJobs = pgTable("blog_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: varchar("kind", { length: 64 }).notNull(),
  dedupeKey: varchar("dedupe_key", { length: 200 }),
  payload: jsonb("payload").notNull(),
  status: varchar("status", { length: 16 }).$type<"pending" | "running" | "done" | "dead">().notNull(),
  attempts: integer("attempts").notNull(),
  maxAttempts: integer("max_attempts").notNull(),
  runAfter: timestamp("run_after", { withTimezone: true }).notNull(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  lastError: varchar("last_error", { length: 1000 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const blogAuditEvents = pgTable("blog_audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id"),
  action: varchar("action", { length: 64 }).notNull(),
  postId: uuid("post_id"),
  revisionId: uuid("revision_id"),
  mediaId: uuid("media_id"),
  authorId: uuid("author_id"),
  categoryId: uuid("category_id"),
  editorId: uuid("editor_id"),
  summary: varchar("summary", { length: 500 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const blogRateLimits = pgTable(
  "blog_rate_limits",
  {
    bucket: varchar("bucket", { length: 200 }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.windowStart] })],
);
