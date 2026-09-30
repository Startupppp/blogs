/**
 * Converts a wall-clock time the editor typed (`2026-03-08T02:30`) in their IANA time zone to UTC
 * instants. Daylight-saving transitions make this non-trivial: a time skipped by a spring-forward
 * has no instant, and a time repeated by a fall-back has two. Both are surfaced, never guessed.
 */
export type WallTimeResolution =
  | { kind: "exact"; instant: Date }
  | { kind: "ambiguous"; earlier: Date; later: Date }
  | { kind: "nonexistent" }
  | { kind: "invalid" };

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function offsetMinutes(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000);
}

export function resolveWallTime(wall: string, timeZone: string): WallTimeResolution {
  const m = WALL.exec(wall);
  if (!m) return { kind: "invalid" };
  const [, y, mo, d, h, mi] = m.map(Number);
  if (y === undefined || mo === undefined || d === undefined || h === undefined || mi === undefined) return { kind: "invalid" };
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(wallAsUtc).getUTCDate() !== d) return { kind: "invalid" };
  const offsets = new Set([offsetMinutes(wallAsUtc - 86_400_000, timeZone), offsetMinutes(wallAsUtc + 86_400_000, timeZone), offsetMinutes(wallAsUtc, timeZone)]);
  const matches = [...offsets]
    .map((off) => wallAsUtc - off * 60_000)
    .filter((instant) => offsetMinutes(instant, timeZone) * 60_000 + instant === wallAsUtc)
    .sort((a, b) => a - b);
  const unique = [...new Set(matches)];
  if (unique.length === 0) return { kind: "nonexistent" };
  if (unique.length === 1) return { kind: "exact", instant: new Date(unique[0] ?? 0) };
  return { kind: "ambiguous", earlier: new Date(unique[0] ?? 0), later: new Date(unique[unique.length - 1] ?? 0) };
}

/** "Tue, 3 Mar 2026, 09:00 GMT+5:30" — the instant as the editor will read it, with its offset. */
export function formatWithOffset(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset",
  }).format(instant);
}
