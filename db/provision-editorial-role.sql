-- Provision the blog admin's least-privilege database access. Run once per environment, AFTER the
-- backend has applied migration 1703, connected as the database owner:
--
--   psql "$OWNER_DATABASE_URL" -v admin_password="$(openssl rand -base64 36)" -f db/provision-editorial-role.sql
--
-- Re-running is safe: every statement is idempotent. Re-run it after any backend migration that
-- adds a blog table the admin writes to (the migration also grants to blog_editorial when it exists).
--
-- `blog_editorial` is a NOLOGIN group holding table privileges on the blog tables and NOTHING else:
-- no HR, payroll, CRM or customer table is readable through it. `blog_admin_app` is the LOGIN role
-- the admin deployment connects as; it inherits only the group's privileges.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'blog_editorial') THEN
    CREATE ROLE blog_editorial NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO blog_editorial;
REVOKE CREATE ON SCHEMA public FROM blog_editorial;

GRANT SELECT, INSERT, UPDATE ON
  blog_posts, blog_post_revisions, blog_authors, blog_categories, blog_media,
  blog_redirects, blog_jobs, blog_editors, blog_rate_limits
  TO blog_editorial;
GRANT DELETE ON blog_revision_media, blog_rate_limits, blog_redirects TO blog_editorial;
GRANT SELECT, INSERT ON blog_revision_media, blog_audit_events TO blog_editorial;
GRANT SELECT ON blog_schema_meta TO blog_editorial;
GRANT UPDATE (publication_generation, updated_at) ON blog_schema_meta TO blog_editorial;

SELECT set_config('blog.admin_password', :'admin_password', false);

DO $$
DECLARE
  pw text := current_setting('blog.admin_password');
BEGIN
  IF length(pw) < 24 THEN
    RAISE EXCEPTION 'admin_password must be at least 24 characters';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'blog_admin_app') THEN
    EXECUTE format('CREATE ROLE blog_admin_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 20', pw);
  ELSE
    EXECUTE format('ALTER ROLE blog_admin_app PASSWORD %L', pw);
  END IF;
  EXECUTE 'GRANT blog_editorial TO blog_admin_app';
END $$;

SELECT set_config('blog.admin_password', '', false);
