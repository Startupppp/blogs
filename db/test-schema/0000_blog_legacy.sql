-- Test-only: the pre-1703 blog tables exactly as streamlineos-backend's 0000 and 0843 create them.
-- Production schema is owned by the backend's migration runner; this file only lets the admin's
-- database tests build an isolated database without the backend's full 1,100-migration chain.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'blog_post_status') THEN
    CREATE TYPE "public"."blog_post_status" AS ENUM('draft', 'published', 'archived');
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS "blog_authors" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "name" varchar(200) NOT NULL, "email" varchar(320), "avatar" text, "bio" text, "role" varchar(100), "twitter" varchar(100), "linkedin" varchar(200), "created_at" timestamp DEFAULT now() NOT NULL, CONSTRAINT "blog_authors_email_unique" UNIQUE("email"));
CREATE TABLE IF NOT EXISTS "blog_categories" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "name" varchar(100) NOT NULL, "slug" varchar(100) NOT NULL, "description" text, "color" varchar(7), "created_at" timestamp DEFAULT now() NOT NULL, CONSTRAINT "blog_categories_name_unique" UNIQUE("name"), CONSTRAINT "blog_categories_slug_unique" UNIQUE("slug"));
CREATE TABLE IF NOT EXISTS "blog_posts" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "title" varchar(256) NOT NULL, "slug" varchar(256) NOT NULL, "excerpt" text NOT NULL, "content" text NOT NULL, "content_json" jsonb, "cover_image" text NOT NULL, "category_id" uuid REFERENCES "blog_categories"("id") ON DELETE set null, "author_id" uuid REFERENCES "blog_authors"("id") ON DELETE set null, "status" "blog_post_status" DEFAULT 'draft' NOT NULL, "is_featured" boolean DEFAULT false NOT NULL, "reading_time" integer, "meta_title" varchar(256), "meta_description" varchar(320), "published_at" timestamp, "tags" text[] DEFAULT '{}' NOT NULL, "created_at" timestamp DEFAULT now() NOT NULL, "updated_at" timestamp DEFAULT now() NOT NULL, CONSTRAINT "blog_posts_slug_unique" UNIQUE("slug"));
CREATE INDEX IF NOT EXISTS "idx_blog_posts_status_published" ON "blog_posts" USING btree ("status","published_at" DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS "idx_blog_posts_search_tsvector" ON "blog_posts" USING gin (to_tsvector('english', "title" || ' ' || "excerpt"));
