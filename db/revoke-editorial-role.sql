-- Emergency revocation: stops the blog admin deployment from connecting at all. The public site is
-- unaffected (it reads through the backend's own role). Undo with db/provision-editorial-role.sql.
ALTER ROLE blog_admin_app NOLOGIN;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'blog_admin_app';
