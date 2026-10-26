import { describe, expect, it } from "vitest";

import { isSameOriginUrl } from "./windowPolicy.mjs";

const appUrl = "http://127.0.0.1:47661";

describe("desktop window policy", () => {
  it("keeps navigation inside the app origin", () => {
    expect(isSameOriginUrl(`${appUrl}/`, appUrl)).toBe(true);
    expect(isSameOriginUrl(`${appUrl}/analysis?id=1#top`, appUrl)).toBe(true);
  });

  it.each([
    "http://127.0.0.1:47662/",
    "http://127.0.0.1:476610/",
    "http://localhost:47661/",
    "http://127.0.0.1:47661.example.com/",
    "https://example.com/",
    "file:///index.html",
    "javascript:alert(1)",
    "reellab://inbox",
    "not a URL",
    "http://user:password@127.0.0.1:47661/",
  ])("sends %s out of the app window", (value) => {
    expect(isSameOriginUrl(value, appUrl)).toBe(false);
  });
});
