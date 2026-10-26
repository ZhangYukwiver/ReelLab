import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createInbox, parseHandoffMeta } from "./inbox.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const ID = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const META = { version: 1, title: "  海边日落  ", author: "阿明", url: "https://example.com/v/1", description: null, durationSeconds: 12.3, sentAt: "2026-10-26T02:00:00.000Z" };

async function inboxWith(files, { importHandoff, now } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "reellab-inbox-"));
  directories.push(root);
  const directory = path.join(root, "inbox");
  await mkdir(directory);
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(directory, name), content);
  const imported = [];
  const inbox = createInbox({
    directory,
    importHandoff: importHandoff ?? (async ({ filePath, meta }) => {
      imported.push({ filePath, meta });
      return { mediaId: "m".repeat(32), title: meta.title, author: meta.author, url: meta.url, description: meta.description, durationSeconds: meta.durationSeconds };
    }),
    now,
    log: () => undefined,
  });
  return { directory, inbox, imported, names: async () => (await readdir(directory)).sort() };
}

describe("handoff inbox", () => {
  it("imports a finished pair and deletes it", async () => {
    const { directory, inbox, imported, names } = await inboxWith({ [`${ID}.mp4`]: "video", [`${ID}.json`]: JSON.stringify(META) });
    expect(await inbox.drain()).toEqual([{ mediaId: "m".repeat(32), title: "海边日落", author: "阿明", url: "https://example.com/v/1", description: null, durationSeconds: 12.3 }]);
    expect(imported).toEqual([{ filePath: path.join(directory, `${ID}.mp4`), meta: { title: "海边日落", author: "阿明", url: "https://example.com/v/1", description: null, durationSeconds: 12.3 } }]);
    expect(await names()).toEqual([]);
    expect(await inbox.drain()).toEqual([]);
  });

  it("skips bad names, missing videos, oversized or mistyped notes, and drops the bad pairs", async () => {
    const { inbox, imported, names } = await inboxWith({
      // 名字不合法（大写）：不认，也不当残留删；收件箱里别的文件不碰
      "ABCDEF0123456789ABCDEF0123456789.json": JSON.stringify(META), "ABCDEF0123456789ABCDEF0123456789.mp4": "v", "notes.txt": "keep",
      // 只有说明、没有视频：不导，先留着
      [`${ID}.json`]: JSON.stringify(META),
      // 说明超过 64KB：整对丢掉
      [`${OTHER}.json`]: JSON.stringify({ ...META, description: "长".repeat(70_000) }), [`${OTHER}.mp4`]: "v",
    });
    expect(await inbox.drain()).toEqual([]);
    expect(imported).toEqual([]);
    expect(await names()).toEqual([`${ID}.json`, "ABCDEF0123456789ABCDEF0123456789.json", "ABCDEF0123456789ABCDEF0123456789.mp4", "notes.txt"]);
  });

  it.each([
    ["not JSON", "{oops"],
    ["wrong version", JSON.stringify({ ...META, version: 2 })],
    ["title missing", JSON.stringify({ ...META, title: undefined })],
    ["author not a string", JSON.stringify({ ...META, author: 7 })],
    ["duration not a number", JSON.stringify({ ...META, durationSeconds: "12" })],
    ["an array", JSON.stringify([META])],
  ])("drops a pair whose note is %s", async (_why, note) => {
    const { inbox, imported, names } = await inboxWith({ [`${ID}.mp4`]: "v", [`${ID}.json`]: note });
    expect(await inbox.drain()).toEqual([]);
    expect(imported).toEqual([]);
    expect(await names()).toEqual([]);
  });

  it("cleans the fields: trims, caps at 500 characters, keeps only web links", () => {
    expect(parseHandoffMeta(JSON.stringify({ version: 1, title: " ", description: `${"字".repeat(600)} `, url: "file:///etc/passwd", durationSeconds: 0 })))
      .toEqual({ title: null, author: null, url: null, description: "字".repeat(500), durationSeconds: null });
    expect(parseHandoffMeta(JSON.stringify({ version: 1, title: "t", durationSeconds: Number.MAX_VALUE }))).toMatchObject({ durationSeconds: Number.MAX_VALUE });
  });

  it("does not follow a symlink posing as the video", async () => {
    const { directory, inbox, imported, names } = await inboxWith({ [`${ID}.json`]: JSON.stringify(META) });
    await writeFile(path.join(directory, "..", "secret.mp4"), "secret");
    await symlink(path.join(directory, "..", "secret.mp4"), path.join(directory, `${ID}.mp4`));
    expect(await inbox.drain()).toEqual([]);
    expect(imported).toEqual([]);
    expect(await names()).toEqual([`${ID}.json`, `${ID}.mp4`]);
  });

  it("retries a failed import, and deletes leftovers and stuck pairs once they are a day old", async () => {
    const clock = { now: Date.now() };
    let failing = true;
    const imported = [];
    const B = "b".repeat(32);
    const C = "c".repeat(32);
    const { directory, inbox, names } = await inboxWith({
      [`${ID}.mp4.part`]: "half", [`${OTHER}.mp4`]: "lonely", [`${"a".repeat(32)}.json.part`]: "{",
      [`${B}.mp4`]: "v", [`${B}.json`]: JSON.stringify(META),
      "notes.txt": "keep",
    }, {
      now: () => clock.now,
      importHandoff: async ({ meta }) => {
        if (failing) throw Object.assign(new Error("素材库满了"), { code: "library_full" });
        imported.push(meta.title);
        return { mediaId: "m".repeat(32), ...meta };
      },
    });
    const touch = (name, time) => utimes(path.join(directory, name), new Date(time), new Date(time));
    // 发件方复制视频时留着很早的修改时间：只要说明文件是新的，这一对就不算过期
    await touch(`${B}.mp4`, clock.now - 3 * 24 * 60 * 60 * 1000);
    expect(await inbox.drain()).toEqual([]);
    expect(await names()).toHaveLength(6);
    // 下次叫醒时导得进去了
    failing = false;
    expect((await inbox.drain()).map((handoff) => handoff.title)).toEqual(["海边日落"]);
    expect(await names()).toEqual([`${"a".repeat(32)}.json.part`, `${ID}.mp4.part`, "notes.txt", `${OTHER}.mp4`].sort());

    // 一天以后：残留删掉，刚放的不动；一直导不进去的那一对也删掉
    failing = true;
    await writeFile(path.join(directory, `${C}.mp4`), "v");
    await writeFile(path.join(directory, `${C}.json`), JSON.stringify(META));
    clock.now += 25 * 60 * 60 * 1000;
    await writeFile(path.join(directory, `${ID}.mp4`), "fresh");
    await touch(`${ID}.mp4`, clock.now);
    expect(await inbox.drain()).toEqual([]);
    expect(await names()).toEqual([`${ID}.mp4`, "notes.txt"]);
    expect(imported).toEqual(["海边日落"]);
  });

  it("never imports the same pair twice when two drains overlap", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = [];
    const { inbox, names } = await inboxWith({ [`${ID}.mp4`]: "v", [`${ID}.json`]: JSON.stringify(META) }, {
      importHandoff: async ({ meta }) => {
        calls.push(meta.title);
        await gate;
        return { mediaId: "m".repeat(32), ...meta };
      },
    });
    const first = inbox.drain();
    const second = inbox.drain();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    expect((await first).map((handoff) => handoff.title)).toEqual(["海边日落"]);
    expect(await second).toEqual([]);
    expect(calls).toEqual(["海边日落"]);
    expect(await names()).toEqual([]);
  });
});
