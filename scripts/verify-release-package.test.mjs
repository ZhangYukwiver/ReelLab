import { describe, expect, it } from "vitest";

import { assertPublicPackagePath, assertPublicUpdateMetadata } from "./verify-release-package.mjs";

describe("release privacy boundary", () => {
  it("accepts generated public updater metadata and rejects credentials", () => {
    const repository = process.env.GITHUB_REPOSITORY ?? "example/project";
    const [owner, repo] = repository.split("/");
    const metadata = `owner: ${owner}\nrepo: ${repo}\nprovider: github\nreleaseType: release\nupdaterCacheDirName: example-app-updater\n`;
    expect(() => assertPublicUpdateMetadata(metadata, "example-app")).not.toThrow();
    expect(() => assertPublicUpdateMetadata(`${metadata}token: private-value\n`, "example-app")).toThrow();
  });

  it.each([
    ".local-data/ai-edit/media/index.json",
    "server/.local-data/analyses.json",
    "dist/analyses.json",
    "app.asar.unpacked/ai-edit/sessions/a.json",
    "server/local-ai/run/system.md",
    "dist/inbox/0123.mp4",
    "server/migrated-from-legacy.json",
    "app.asar.unpacked/profile/Default/Network/Cookies",
    "dist/Local State",
    "dist/Login Data-journal",
    "dist/.env.local",
    "dist/../analyses.json",
    "server\\.local-data\\analyses.json",
  ])("rejects personal runtime data at any package depth: %s", (name) => {
    expect(() => assertPublicPackagePath(name)).toThrow();
  });

  it.each([
    "server/server.mjs",
    "server/aiEdit/index.mjs",
    "server/aiEdit/catalog.json",
    "server/licenses/openfilm-LICENSE.txt",
    "desktop/inbox.mjs",
    "node_modules/playwright-core/lib/server/cookieStore.js",
    "node_modules/electron-updater/out/AppUpdater.js",
    "node_modules/builder-util-runtime/out/index.js",
    "dist/_expo/static/js/web/AppEntry-example.js",
  ])("allows shipped application code: %s", (name) => {
    expect(() => assertPublicPackagePath(name)).not.toThrow();
  });
});
