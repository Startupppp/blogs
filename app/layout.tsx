import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Journal CMS", template: "%s · Journal CMS" },
  robots: { index: false, follow: false, nocache: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
