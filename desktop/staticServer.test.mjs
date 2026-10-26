import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startStaticServer } from "./staticServer.mjs";

const temporaryDirectories = [];
const runtimes = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "reellab-static-"));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, "assets"));
  await writeFile(path.join(directory, "index.html"), "<!doctype html><title>Desktop fixture</title>");
  await writeFile(path.join(directory, "assets", "app.js"), "console.log('fixture');");
  return directory;
}

describe("desktop static server", () => {
  it("serves exported assets with security headers", async () => {
    const runtime = await startStaticServer({ rootDirectory: await fixture() });
    runtimes.push(runtime);

    const response = await fetch(`${runtime.url}/assets/app.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    await expect(response.text()).resolves.toContain("fixture");
  });

  it("falls back to the app shell only for HTML navigation", async () => {
    const runtime = await startStaticServer({ rootDirectory: await fixture() });
    runtimes.push(runtime);

    const navigation = await fetch(`${runtime.url}/annual/2025`, { headers: { Accept: "text/html" } });
    expect(navigation.status).toBe(200);
    await expect(navigation.text()).resolves.toContain("Desktop fixture");

    const missingAsset = await fetch(`${runtime.url}/assets/missing.js`);
    expect(missingAsset.status).toBe(404);
  });

  it.each(["/", "/annual/2025"])("lets the page reach the local service for media, images, frames and video blobs at %s", async (pathname) => {
    const runtime = await startStaticServer({ rootDirectory: await fixture() });
    runtimes.push(runtime);

    const response = await fetch(`${runtime.url}${pathname}`, { headers: { Accept: "text/html" } });
    const directives = response.headers.get("content-security-policy").split(";").map((value) => value.trim().split(/\s+/u));
    expect(directives.find(([name]) => name === "media-src")).toEqual([
      "media-src", "'self'", "https:", "blob:", "http://127.0.0.1:*", "http://localhost:*",
    ]);
    // AI 剪辑素材库的图片和缩略图直接从本机服务取（素材文件地址靠 key，不带 Bearer）
    expect(directives.find(([name]) => name === "img-src")).toEqual([
      "img-src", "'self'", "data:", "https:", "http://127.0.0.1:*", "http://localhost:*",
    ]);
    // 看板里的网页片段放在本机服务的跨源 iframe 里
    expect(directives.find(([name]) => name === "frame-src")).toEqual(["frame-src", "'self'", "http://127.0.0.1:*", "http://localhost:*"]);
    // 接口只连本机服务
    expect(directives.find(([name]) => name === "connect-src")).toEqual(["connect-src", "'self'", "http://127.0.0.1:*", "http://localhost:*"]);
    expect(directives.find(([name]) => name === "script-src")).toEqual(["script-src", "'self'"]);
    expect(directives.find(([name]) => name === "frame-ancestors")).toEqual(["frame-ancestors", "'none'"]);
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });
});
