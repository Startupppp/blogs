const TONE: Record<string, string> = {
  Draft: "bg-sage text-ink",
  Scheduled: "bg-warn-soft text-warn",
  Published: "bg-ok-soft text-ok",
  "Published · edits pending": "bg-ok-soft text-ok",
  Archived: "bg-rule text-muted",
};

export function StatusBadge({ label }: { label: string }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[label] ?? "bg-sage"}`}>{label}</span>;
}
