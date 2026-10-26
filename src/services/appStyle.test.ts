import { describe, expect, it } from "vitest";

import { applyAppStyle } from "./appStyle";

describe("app style", () => {
  it("hangs the minimal style on <html data-style> so the minimal and AI layout layers match", () => {
    const doc = { documentElement: { dataset: {} as Record<string, string | undefined> } };
    applyAppStyle("minimal", doc);
    expect(doc.documentElement.dataset.style).toBe("minimal");
    expect(() => applyAppStyle("minimal", undefined)).not.toThrow();
  });
});
