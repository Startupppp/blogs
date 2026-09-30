import { describe, expect, it } from "vitest";
import { LocalTime } from "@/components/ui/local-time";

describe("LocalTime", () => {
  it("formats an instant with its offset instead of throwing", () => {
    const el = LocalTime({ iso: "2026-03-01T09:30:00.000Z" }) as { props: { children: string; dateTime: string } };
    expect(el.props.dateTime).toBe("2026-03-01T09:30:00.000Z");
    expect(el.props.children).toMatch(/2026/);
    expect(el.props.children).toMatch(/GMT|UTC/);
  });
});
