import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { articleExtensions, editorDocument } from "@/components/editor/extensions";

describe("editorDocument", () => {
  it("returns plain objects, so React can pass node attrs to a Server Action", () => {
    const schema = getSchema(articleExtensions);
    const node = schema.nodeFromJSON({ type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Hi" }] }] });
    const raw = node.toJSON() as { content: { attrs: object }[] };
    expect(Object.getPrototypeOf(raw.content[0]!.attrs)).toBeNull(); // what ProseMirror hands out

    const doc = editorDocument({ getJSON: () => node.toJSON() }) as { content: { attrs: object }[] };
    expect(Object.getPrototypeOf(doc.content[0]!.attrs)).toBe(Object.prototype);
    expect(doc).toEqual({ type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Hi" }] }] });
  });
});
