"use client";

/** Renders an instant in the viewer's own time zone, with the offset shown. */
export function LocalTime({ iso, fallback = "—" }: { iso: string | null; fallback?: string }) {
  if (!iso) return <>{fallback}</>;
  const date = new Date(iso);
  const text = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZoneName: "shortOffset" }).format(date);
  return <time dateTime={iso} suppressHydrationWarning>{text}</time>;
}
