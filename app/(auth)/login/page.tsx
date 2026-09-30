import { redirect } from "next/navigation";
import { signIn } from "@/lib/server/auth/auth";
import { currentEditor } from "@/lib/server/auth/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

const MESSAGES: Record<string, string> = {
  AccessDenied: "This Google account does not have editorial access. Ask a publication administrator to add your email.",
  Configuration: "Sign-in is not configured correctly. Contact the publication administrator.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentEditor().catch(() => null)) redirect("/posts");
  const { error } = await searchParams;
  const message = error ? (MESSAGES[error] ?? "Sign-in failed. Try again.") : null;

  async function signInWithGoogle() {
    "use server";
    await signIn("google", { redirectTo: "/posts" });
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">The StreamlineOS Journal</p>
      <h1 className="mt-3 font-serif text-4xl">Editorial CMS</h1>
      <p className="mt-3 text-muted">Sign in with the Google account your editorial administrator added.</p>
      {message ? (
        <p role="alert" className="mt-6 rounded-md bg-danger-soft px-4 py-3 text-sm text-danger">{message}</p>
      ) : null}
      <form action={signInWithGoogle} className="mt-8">
        <button type="submit" className="min-h-11 w-full rounded-md bg-ink px-4 py-2.5 font-medium text-paper hover:opacity-90">
          Continue with Google
        </button>
      </form>
      <p className="mt-6 text-xs text-muted">There is no public sign-up. Access is granted per person and can be revoked at any time.</p>
    </main>
  );
}
