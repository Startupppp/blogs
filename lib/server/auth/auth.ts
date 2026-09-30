import "server-only";
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { env } from "../env";
import { bindEditorOnSignIn } from "./editor";

const SESSION_COOKIE = (secure: boolean) => `${secure ? "__Secure-" : ""}blog-admin.session-token`;

/**
 * Sign-in is Google OIDC through this admin's own client registration and callback
 * (`/api/auth/callback/google`), with a host-only session cookie. Nobody can sign up: the sign-in
 * callback admits only a verified Google account whose email has an enabled `blog_editors` row,
 * and binds that row to the Google subject on first use.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const e = env();
  const secure = e.AUTH_URL.startsWith("https://");
  return {
    secret: e.AUTH_SECRET,
    // Auth.js refuses every request unless trustHost is true (an explicit false is not defaulted).
    // It is safe because env() requires AUTH_URL: next-auth rebuilds each request URL from it,
    // so the Host header never decides a callback or redirect origin.
    trustHost: true,
    providers: [Google({ clientId: e.AUTH_GOOGLE_ID, clientSecret: e.AUTH_GOOGLE_SECRET })],
    session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
    // Its own cookie name: the Streamline OS app uses Auth.js' default, and on a shared host
    // (localhost in development) each app would overwrite the other's session.
    cookies: {
      sessionToken: {
        name: SESSION_COOKIE(secure),
        options: { httpOnly: true, sameSite: "lax", path: "/", secure },
      },
    },
    pages: { signIn: "/login", error: "/login" },
    callbacks: {
      async signIn({ account, profile }) {
        if (account?.provider !== "google" || !profile?.email || profile.email_verified !== true || !profile.sub) return false;
        return (await bindEditorOnSignIn(profile.email, profile.sub, profile.name ?? null)) !== null;
      },
      async jwt({ token, account, profile }) {
        if (account && profile?.sub) {
          token.subject = profile.sub;
          token.email = profile.email?.toLowerCase();
        }
        return token;
      },
      async session({ session, token }) {
        return { ...session, subject: typeof token.subject === "string" ? token.subject : null };
      },
    },
  };
});
