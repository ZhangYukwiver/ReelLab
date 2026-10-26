import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { migrateLegacyData, rewriteRoot } from "./migrate.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function roots() {
  const appData = await realpath(await mkdtemp(path.join(tmpdir(), "reellab-migrate-")));
  directories.push(appData);
  return { appData, legacyRoot: path.join(appData, "内容数据工作台", "collector"), dataDirectory: path.join(appData, "ReelLab", "data") };
}

describe("rewriteRoot", () => {
  it("swaps a posix root written as is and inside nested JSON, but not a longer folder name", () => {
    const from = "/Users/me/Library/Application Support/内容数据工作台/collector";
    const to = "/Users/me/Library/Application Support/ReelLab/data";
    const nested = JSON.stringify({ arguments: JSON.stringify({ path: `${from}/ai-edit/media/a.mp4` }) });
    const text = JSON.stringify({ file: `${from}/ai-edit/media/a.mp4`, root: from, other: `${from}-2/x`, nested });
    const result = JSON.parse(rewriteRoot(text, from, to));
    expect(result).toMatchObject({ file: `${to}/ai-edit/media/a.mp4`, root: to, other: `${from}-2/x` });
    expect(JSON.parse(JSON.parse(result.nested).arguments).path).toBe(`${to}/ai-edit/media/a.mp4`);
  });

  it("swaps a Windows root in raw, JSON-escaped and double-escaped form", () => {
    const from = "C:\\Users\\me\\AppData\\Roaming\\内容数据工作台\\collector";
    const to = "C:\\Users\\me\\AppData\\Roaming\\ReelLab\\data";
    const file = `${from}\\ai-edit\\media\\a.mp4`;
    const json = JSON.stringify({ file, mediaRoots: [`${from}\\ai-edit\\media`], arguments: JSON.stringify({ path: file }) });
    expect(json).toContain("C:\\\\Users");
    const result = JSON.parse(rewriteRoot(json, from, to));
    expect(result.file).toBe(`${to}\\ai-edit\\media\\a.mp4`);
    expect(result.mediaRoots).toEqual([`${to}\\ai-edit\\media`]);
    expect(JSON.parse(result.arguments).path).toBe(`${to}\\ai-edit\\media\\a.mp4`);
    expect(rewriteRoot(`log: ${file}`, from, to)).toBe(`log: ${to}\\ai-edit\\media\\a.mp4`);
    expect(rewriteRoot("nothing here", from, to)).toBe("nothing here");
  });
});

describe("migrateLegacyData", () => {
  it("copies AI edit data once, rewriting absolute paths, and leaves the old folder alone", async () => {
    const { legacyRoot, dataDirectory } = await roots();
    const media = path.join(legacyRoot, "ai-edit", "media");
    await mkdir(media, { recursive: true });
    await mkdir(path.join(legacyRoot, "ai-edit", "projects"), { recursive: true });
    await mkdir(path.join(legacyRoot, "local-ai"), { recursive: true });
    await writeFile(path.join(media, "a.mp4"), "video");
    await writeFile(path.join(media, "index.json"), JSON.stringify([{ id: "a", file: "a.mp4" }]));
    await writeFile(path.join(legacyRoot, "ai-edit", "projects", "p.json"), JSON.stringify({ path: path.join(media, "a.mp4") }));
    await writeFile(path.join(legacyRoot, "local-ai", "state.json"), JSON.stringify({ cwd: path.join(legacyRoot, "local-ai", "work") }));
    await writeFile(path.join(legacyRoot, "analyses.json"), JSON.stringify([{ id: "x", status: "complete", sourceUrl: "https://example.com/v/1" }]));
    await writeFile(path.join(legacyRoot, "records.json"), "{}");

    const started = [];
    expect(await migrateLegacyData({ legacyRoot, dataDirectory, onStart: () => started.push(1) })).toEqual({ migrated: true, copied: ["local-ai", "analyses.json", "ai-edit"] });
    expect(started).toHaveLength(1);
    expect((await readdir(dataDirectory)).sort()).toEqual(["ai-edit", "analyses.json", "local-ai", "migrated-from-legacy.json"]);
    expect(await readFile(path.join(dataDirectory, "ai-edit", "media", "a.mp4"), "utf8")).toBe("video");
    expect(JSON.parse(await readFile(path.join(dataDirectory, "ai-edit", "projects", "p.json"), "utf8")).path).toBe(path.join(dataDirectory, "ai-edit", "media", "a.mp4"));
    expect(JSON.parse(await readFile(path.join(dataDirectory, "local-ai", "state.json"), "utf8")).cwd).toBe(path.join(dataDirectory, "local-ai", "work"));
    expect(JSON.parse(await readFile(path.join(dataDirectory, "analyses.json"), "utf8"))[0]).toMatchObject({ id: "x", status: "complete" });
    // 旧的原样留着
    expect(JSON.parse(await readFile(path.join(legacyRoot, "ai-edit", "projects", "p.json"), "utf8")).path).toBe(path.join(media, "a.mp4"));

    // 只迁一次：用户在新应用里删光了 ai-edit 也不再拷
    await rm(path.join(dataDirectory, "ai-edit"), { recursive: true });
    expect(await migrateLegacyData({ legacyRoot, dataDirectory, onStart: () => started.push(1) })).toEqual({ migrated: false, copied: [] });
    expect(await readdir(dataDirectory)).not.toContain("ai-edit");
    expect(started).toHaveLength(1);
  });

  it("only takes what exists, and does nothing when there is no old data or new data already exists", async () => {
    const { legacyRoot, dataDirectory } = await roots();
    expect(await migrateLegacyData({ legacyRoot, dataDirectory })).toEqual({ migrated: false, copied: [] });
    await expect(readdir(dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(path.join(legacyRoot, "ai-edit"), { recursive: true });
    await mkdir(path.join(dataDirectory, "ai-edit"), { recursive: true });
    expect(await migrateLegacyData({ legacyRoot, dataDirectory })).toEqual({ migrated: false, copied: [] });
    expect(await readdir(dataDirectory)).toEqual(["ai-edit"]);

    await rm(path.join(dataDirectory, "ai-edit"), { recursive: true });
    await writeFile(path.join(legacyRoot, "ai-edit", "x.json"), "[]");
    expect(await migrateLegacyData({ legacyRoot, dataDirectory })).toEqual({ migrated: true, copied: ["ai-edit"] });
  });

  it("moves ai-edit last, so a failure while moving is picked up again on the next start", async () => {
    const { legacyRoot, dataDirectory } = await roots();
    await mkdir(path.join(legacyRoot, "ai-edit"), { recursive: true });
    await mkdir(path.join(legacyRoot, "local-ai"), { recursive: true });
    await writeFile(path.join(legacyRoot, "ai-edit", "p.json"), JSON.stringify({ root: legacyRoot }));
    await writeFile(path.join(legacyRoot, "analyses.json"), "[]");
    // 挪 ai-edit 时被占着（Windows 杀毒扫描），别的已经挪过去了
    const blocked = async (from, to) => {
      if (path.basename(from) === "ai-edit") throw Object.assign(new Error("busy"), { code: "EBUSY" });
      await rename(from, to);
    };
    await expect(migrateLegacyData({ legacyRoot, dataDirectory, rename: blocked })).rejects.toMatchObject({ code: "EBUSY" });
    expect((await readdir(dataDirectory)).sort()).toEqual([".migrating", "analyses.json", "local-ai"]);

    expect(await migrateLegacyData({ legacyRoot, dataDirectory })).toEqual({ migrated: true, copied: ["ai-edit"] });
    expect((await readdir(dataDirectory)).sort()).toEqual(["ai-edit", "analyses.json", "local-ai", "migrated-from-legacy.json"]);
    expect(JSON.parse(await readFile(path.join(dataDirectory, "ai-edit", "p.json"), "utf8")).root).toBe(dataDirectory);
  });

  it("clears a leftover staging folder when ai-edit already made it over", async () => {
    const { legacyRoot, dataDirectory } = await roots();
    await mkdir(path.join(legacyRoot, "ai-edit"), { recursive: true });
    await mkdir(path.join(dataDirectory, "ai-edit"), { recursive: true });
    await mkdir(path.join(dataDirectory, ".migrating"), { recursive: true });
    expect(await migrateLegacyData({ legacyRoot, dataDirectory })).toEqual({ migrated: false, copied: [] });
    expect(await readdir(dataDirectory)).toEqual(["ai-edit"]);
  });
});
