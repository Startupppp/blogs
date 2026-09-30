import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/lib/server/auth/auth";
import { currentEditor, requireEditor } from "@/lib/server/auth/session";
import { can } from "@/lib/server/auth/roles";
import { policy } from "@/lib/server/auth/editor";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const editor = await currentEditor();
  if (!editor) redirect("/login");
  const p = policy();
  const nav = [
    { href: "/posts", label: "Posts", show: true },
    { href: "/media", label: "Media", show: true },
    { href: "/authors", label: "Authors", show: can(editor.role, "taxonomy:manage", p) },
    { href: "/categories", label: "Categories", show: can(editor.role, "taxonomy:manage", p) },
    { href: "/redirects", label: "Redirects", show: can(editor.role, "redirects:manage", p) },
    { href: "/editors", label: "Editors", show: can(editor.role, "editors:manage", p) },
    { href: "/operations", label: "Operations", show: can(editor.role, "post:publish", p) },
  ].filter((n) => n.show);

  async function signOutAction() {
    "use server";
    await requireEditor().catch(() => null);
    await signOut({ redirectTo: "/login" });
  }

  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="border-b border-rule bg-surface">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <Link href="/posts" className="font-serif text-lg">Journal CMS</Link>
          <nav aria-label="Main" className="flex flex-wrap gap-1 text-sm">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className="rounded px-2.5 py-2 text-muted hover:bg-sage hover:text-ink">{n.label}</Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-muted">
            <span>{editor.email} · <span className="capitalize">{editor.role}</span></span>
            <form action={signOutAction}>
              <button type="submit" className="rounded px-2.5 py-2 hover:bg-sage hover:text-ink">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-7xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
