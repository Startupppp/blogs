"use client";

/** Renders an instant in the viewer's own time zone, with the offset shown. */
export function LocalTime({ iso, fallback = "—" }: { iso: string | null; fallback?: string }) {
  if (!iso) return <>{fallback}</>;
  const date = new Date(iso);
  // dateStyle/timeStyle cannot be combined with timeZoneName (TypeError), so spell out the parts.
  const text = new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "shortOffset",
  }).format(date);
  return <time dateTime={iso} suppressHydrationWarning>{text}</time>;
}
