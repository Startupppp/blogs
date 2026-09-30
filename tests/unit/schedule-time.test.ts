import { describe, expect, it } from "vitest";
import { formatWithOffset, resolveWallTime } from "@/lib/content/schedule-time";

describe("schedule wall time", () => {
  it("resolves an ordinary time to one UTC instant", () => {
    expect(resolveWallTime("2026-07-01T09:00", "Asia/Kolkata")).toEqual({ kind: "exact", instant: new Date("2026-07-01T03:30:00Z") });
    expect(resolveWallTime("2026-07-01T09:00", "America/New_York")).toEqual({ kind: "exact", instant: new Date("2026-07-01T13:00:00Z") });
  });

  it("reports a time skipped by spring-forward as nonexistent", () => {
    expect(resolveWallTime("2026-03-08T02:30", "America/New_York")).toEqual({ kind: "nonexistent" });
  });

  it("reports a time repeated by fall-back as ambiguous with both instants", () => {
    expect(resolveWallTime("2026-11-01T01:30", "America/New_York")).toEqual({
      kind: "ambiguous",
      earlier: new Date("2026-11-01T05:30:00Z"),
      later: new Date("2026-11-01T06:30:00Z"),
    });
  });

  it("rejects malformed and impossible dates", () => {
    expect(resolveWallTime("2026-02-30T10:00", "UTC").kind).toBe("invalid");
    expect(resolveWallTime("tomorrow", "UTC").kind).toBe("invalid");
  });

  it("shows the offset with the time", () => {
    expect(formatWithOffset(new Date("2026-07-01T03:30:00Z"), "Asia/Kolkata")).toMatch(/09:00 GMT\+5:30/);
  });
});
