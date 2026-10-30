import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startServer } from "./server.mjs";

const temporaryDirectories = [];
const runtimes = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const exists = (target) => access(target).then(() => true, () => false);
const fixture = fileURLToPath(new URL("fixtures/ai-edit/media/clip-720p.mp4", import.meta.url));

async function startPaired(prefix) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(dataDirectory);
  const runtime = await startServer({ port: 0, dataDirectory, filmBrowser: null });
  runtimes.push(runtime);
  const paired = await fetch(`${runtime.baseUrl}/v1/pair`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }),
  }).then((response) => response.json());
  const headers = { Authorization: `Bearer ${paired.token}` };
  const call = async (pathname, method = "GET", body) => {
    const response = await fetch(`${runtime.baseUrl}${pathname}`, {
      method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { dataDirectory, runtime, call, headers };
}

describe("SmartCut server", () => {
  it("keeps AI edit behind pairing except key-protected media files, and stores everything under ai-edit/", async () => {
    // 草稿箱指到临时目录，不碰本机真实的剪映草稿
    vi.stubEnv("JY_JIANYING_DRAFTS_ROOT", await mkdtemp(path.join(tmpdir(), "ai-edit-drafts-")));
    temporaryDirectories.push(process.env.JY_JIANYING_DRAFTS_ROOT);
    try {
      const { dataDirectory, runtime, call, headers } = await startPaired("reellab-routes-");
      expect(await (await fetch(`${runtime.baseUrl}/v1/health`)).json()).toEqual({ ok: true, version: 1, app: "reellab" });
      expect((await fetch(`${runtime.baseUrl}/v1/ai-edit/sessions`)).status).toBe(401);
      expect((await fetch(`${runtime.baseUrl}/v1/ai-edit/media`)).status).toBe(401);
      expect((await fetch(`${runtime.baseUrl}/v1/analyses`)).status).toBe(401);
      expect((await fetch(`${runtime.baseUrl}/v1/status`)).status).toBe(401);
      expect(await call("/v1/status")).toEqual({ status: 200, body: { ok: true } });
      expect(await call("/v1/ai-edit/sessions")).toEqual({ status: 200, body: { sessions: [] } });
      expect(await call("/v1/nope")).toEqual({ status: 404, body: { error: "not_found" } });

      const bytes = await readFile(fixture);
      const uploaded = await fetch(`${runtime.baseUrl}/v1/ai-edit/media/upload?name=clip.mp4`, { method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: bytes });
      expect(uploaded.status).toBe(201);
      const { item } = await uploaded.json();
      expect(item).toMatchObject({ kind: "video", status: "ready", durationUs: 3_000_000, width: 1280, height: 720, hasAudio: true });
      const { key } = (await call("/v1/ai-edit/media")).body;
      const fileUrl = `${runtime.baseUrl}/v1/ai-edit/media/${item.id}/file?key=${encodeURIComponent(key)}`;
      const file = await fetch(fileUrl, { headers: { Range: "bytes=0-9" } });
      expect(file.status).toBe(206);
      expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes.subarray(0, 10));
      expect((await fetch(`${runtime.baseUrl}/v1/ai-edit/media/${item.id}/file?key=nope`)).status).toBe(404);
      // 看板取缩略图用 <video crossOrigin="anonymous">：本机页面（开发服、打包版的静态服务）要拿到 CORS 头，画布才不被污染；
      // 别的来源照旧拒绝，也不回通配符
      const local = await fetch(fileUrl, { headers: { Origin: "http://127.0.0.1:47661", Range: "bytes=0-9" } });
      expect(local.status).toBe(206);
      expect(local.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:47661");
      expect(local.headers.get("vary")).toBe("Origin");
      await local.arrayBuffer();
      const full = await fetch(fileUrl, { headers: { Origin: "http://localhost:8081" } });
      expect(full.status).toBe(200);
      expect(full.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
      await full.arrayBuffer();
      const foreign = await fetch(fileUrl, { headers: { Origin: "https://example.com" } });
      expect(foreign.status).toBe(403);
      expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
      await foreign.arrayBuffer();

      const created = await fetch(`${runtime.baseUrl}/v1/ai-edit/sessions`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ title: "测试剪辑" }) });
      expect(created.status).toBe(201);
      const { session, project } = await created.json();
      expect(project).toMatchObject({ name: "测试剪辑", canvas: { width: 1080, height: 1920, fps: 30 }, tracks: [] });
      expect(await exists(path.join(dataDirectory, "ai-edit", "sessions", `${session.id}.json`))).toBe(true);
      expect(await exists(path.join(dataDirectory, "ai-edit", "media", `${item.id}.mp4`))).toBe(true);
      expect((await readdir(path.join(dataDirectory, "ai-edit", "projects"))).some((name) => name.startsWith(project.id))).toBe(true);
      expect((await call("/v1/ai-edit/draft-box")).body).toMatchObject({ status: expect.stringMatching(/^(?:available|unavailable)$/u), jianyingRunning: expect.any(Boolean) });
      expect((await call(`/v1/ai-edit/sessions/${session.id}/export`, "POST")).body.error).toMatch(/^(?:project_empty|draft_box_unavailable)$/u);

      // 关服务时页面还挂着会话长轮询，也要马上关掉
      const polling = fetch(`${runtime.baseUrl}/v1/ai-edit/sessions/${session.id}?afterRevision=${session.revision}`, { headers }).then((response) => response.status).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const startedAt = Date.now();
      await runtime.close();
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect([200, null]).toContain(await polling);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 20_000);

  it("imports a video sent from another app and analyses library videos only", async () => {
    const { runtime, call } = await startPaired("reellab-handoff-");
    const inbox = await mkdtemp(path.join(tmpdir(), "reellab-inbox-"));
    temporaryDirectories.push(inbox);
    const sent = path.join(inbox, `${"0".repeat(32)}.mp4`);
    await copyFile(fixture, sent);
    const handoff = await runtime.importHandoff({ filePath: sent, meta: { title: "海边日落", author: "阿明", url: "https://example.com/v/1", description: "一段海边", durationSeconds: null } });
    expect(handoff).toEqual({ mediaId: expect.stringMatching(/^[0-9a-f]{32}$/u), title: "海边日落", author: "阿明", url: "https://example.com/v/1", description: "一段海边", durationSeconds: 3 });
    const { media } = (await call("/v1/ai-edit/media")).body;
    expect(media.find((entry) => entry.id === handoff.mediaId)).toMatchObject({ name: "海边日落", status: "ready", source: { type: "handoff", title: "海边日落", author: "阿明", url: "https://example.com/v/1" } });
    // 没有标题也能收，名字用「送来的视频」
    const untitled = await runtime.importHandoff({ filePath: sent, meta: { title: null, author: null, url: null, description: null, durationSeconds: 12 } });
    expect(untitled).toMatchObject({ title: "送来的视频", author: null, url: null, durationSeconds: 12 });

    // 解析库只认素材库里就绪的视频；接口配置不对先报配置
    const config = { baseUrl: "https://ark.example.com/api/v3", apiKey: "k", model: "m" };
    expect(await call("/v1/analyses", "POST", { mediaId: "f".repeat(32), config })).toMatchObject({ status: 404, body: { error: "media_not_found" } });
    expect(await call("/v1/analyses", "POST", { config })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(await call("/v1/analyses", "POST", { mediaId: handoff.mediaId, config: { baseUrl: "ftp://x" } })).toMatchObject({ status: 400, body: { error: "invalid_config" } });
    const oversized = await call("/v1/analyses", "POST", { mediaId: handoff.mediaId, config, video: { description: "长".repeat(20_000) } });
    expect(oversized).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(await call("/v1/analyses")).toEqual({ status: 200, body: { analyses: [] } });
    expect(await call("/v1/analyses/looks")).toEqual({ status: 200, body: { looks: [] } });
    expect((await call("/v1/analyses", "PATCH")).status).toBe(405);
    expect(await call(`/v1/analyses/${"a".repeat(8)}-aaaa-aaaa-aaaa-${"a".repeat(12)}`, "DELETE")).toEqual({ status: 200, body: { removed: false } });
  }, 20_000);

  it("won't pair or answer paired routes for pages it hosts itself, but still serves them their files", async () => {
    const { dataDirectory, runtime, call, headers } = await startPaired("reellab-same-origin-");
    const base = runtime.baseUrl;
    const port = new URL(base).port;
    // 服务自己放出去的页面发来的请求：同源时浏览器自动带 same-origin（脚本改不了）；页面换个主机名打回来
    // （127.0.0.1 ↔ localhost）浏览器算 cross-site，但 Origin 的端口还是服务的
    const ownPages = [
      { "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Site": "cross-site", Origin: `http://127.0.0.1:${port}` },
      { "Sec-Fetch-Site": "cross-site", Origin: `http://localhost:${port}` },
    ];
    const pair = (extra) => fetch(`${base}/v1/pair`, { method: "POST", headers: { ...extra, "Content-Type": "application/json" }, body: JSON.stringify({ code: runtime.getPairingCode() }) });

    const pairingCode = runtime.getPairingCode();
    for (const own of ownPages) {
      const code = await fetch(`${base}/v1/pairing-code`, { headers: own });
      expect(code.status).toBe(403);
      expect(await code.json()).not.toHaveProperty("code");
      // 页面拿不到配对码，也不能拿猜到的码一直试：拒掉的不占本机的尝试次数，应用随后照常能配对
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const refused = await pair(own);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({ error: "same_origin_not_allowed" });
      }
    }
    expect(runtime.getPairingCode()).toBe(pairingCode);
    // 局域网地址、[::1] 这些主机名的页面本来就过不了来源检查
    for (const host of ["192.168.1.5", "[::1]"]) {
      const lan = { "Sec-Fetch-Site": "cross-site", Origin: `http://${host}:${port}` };
      expect((await fetch(`${base}/v1/pairing-code`, { headers: lan })).status).toBe(403);
      expect((await pair(lan)).status).toBe(403);
    }

    const { session } = await (await fetch(`${base}/v1/ai-edit/sessions`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" })).json();
    const spendUrl = `${base}/v1/ai-edit/sessions/${session.id}/spend/0123456789abcdef`;
    const answer = (extra) => fetch(spendUrl, { method: "POST", headers: { ...headers, ...extra, "Content-Type": "application/json" }, body: JSON.stringify({ allow: true }) });
    // 技能命令的确认、技能的「不用问」开关也一样：页面替用户点不了「运行」
    const commandUrl = `${base}/v1/ai-edit/sessions/${session.id}/command/0123456789abcdef`;
    const answerCommand = (extra) => fetch(commandUrl, { method: "POST", headers: { ...headers, ...extra, "Content-Type": "application/json" }, body: JSON.stringify({ allow: true, remember: true }) });
    const trust = (extra) => fetch(`${base}/v1/ai-edit/skills/some-skill`, { method: "PATCH", headers: { ...headers, ...extra, "Content-Type": "application/json" }, body: JSON.stringify({ trustCommands: true }) });
    // 带着合法 token 也不行：页面万一从别处拿到了 token，同样替用户答不了花钱确认，也开始不了要花钱的解析
    for (const own of ownPages) {
      for (const response of [
        await fetch(`${base}/v1/ai-edit/sessions`, { headers: { ...headers, ...own } }), await answer(own), await answerCommand(own), await trust(own),
        await fetch(`${base}/v1/status`, { headers: { ...headers, ...own } }),
        await fetch(`${base}/v1/analyses`, { method: "POST", headers: { ...headers, ...own, "Content-Type": "application/json" }, body: "{}" }),
      ]) {
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "same_origin_not_allowed" });
      }
    }

    // 应用页面（47661 端口是 same-site，开发服务器的 localhost 是 cross-site）、地址栏直接打开（none）和 Node 客户端（不带头）照旧
    for (const site of [
      { "Sec-Fetch-Site": "same-site", Origin: "http://127.0.0.1:47661" },
      { "Sec-Fetch-Site": "cross-site", Origin: "http://localhost:8081" },
      { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "none" }, {},
    ]) {
      const shown = await fetch(`${base}/v1/pairing-code`, { headers: site });
      expect(shown.status).toBe(200);
      expect(shown.headers.get("access-control-allow-origin")).toBe(site.Origin ?? null);
      expect(await shown.json()).toEqual({ code: runtime.getPairingCode() });
      expect((await fetch(`${base}/v1/ai-edit/sessions`, { headers: { ...headers, ...site } })).status).toBe(200);
      // 能走到确认接口本身（这里没有挂着的确认，答「找不到」）
      const answered = await answer(site);
      expect(answered.status).toBe(404);
      expect(await answered.json()).toMatchObject({ error: "spend_not_found" });
      const commanded = await answerCommand(site);
      expect(commanded.status).toBe(404);
      expect(await commanded.json()).toMatchObject({ error: "spend_not_found" });
      const trusted = await trust(site);
      expect(trusted.status).toBe(404);
      expect(await trusted.json()).toMatchObject({ error: "skill_not_found" });
    }
    // 设置里开关技能用 PATCH：跨源的应用页面要先过预检
    const preflight = await fetch(`${base}/v1/ai-edit/skills/some-skill`, {
      method: "OPTIONS", headers: { Origin: "http://localhost:8081", "Access-Control-Request-Method": "PATCH" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PATCH");
    const paired = await pair({ "Sec-Fetch-Site": "same-site", Origin: "http://127.0.0.1:47661" });
    expect(paired.status).toBe(200);
    expect((await paired.json()).token).toHaveLength(43);

    // 网页片段和 film 的文件不用配对，同源页面加载自己的东西照常
    const { filmKey } = (await call("/v1/ai-edit/media")).body;
    await mkdir(path.join(dataDirectory, "ai-edit", "pages", "p1"), { recursive: true });
    await writeFile(path.join(dataDirectory, "ai-edit", "pages", "p1", "index.html"), "<html><head></head><body><script>window.film={frame(){}}</script></body></html>");
    await writeFile(path.join(dataDirectory, "ai-edit", "pages", "p1", "data.json"), "{\"ok\":true}");
    const film = `${base}/v1/ai-edit/film/${encodeURIComponent(filmKey)}`;
    const place = `http://127.0.0.1:${port}/v1/ai-edit/film/${filmKey}/`;
    for (const own of ownPages) {
      const page = await fetch(`${film}/pages/p1/index.html`, { headers: own });
      expect(page.status).toBe(200);
      // 第二条策略：页面只能往这个网页片段的文件夹发请求、嵌页面（按这次请求的地址生成）
      expect(page.headers.get("content-security-policy")).toContain(`, connect-src ${place} data: blob: `);
      expect(page.headers.get("content-security-policy").endsWith(`; frame-src ${place}`)).toBe(true);
      await page.text();
      const data = await fetch(`${film}/pages/p1/data.json`, { headers: own });
      // 单独打开也受同样的限制（SVG 文档、worker 脚本靠这个）
      expect(data.headers.get("content-security-policy")).toBe(page.headers.get("content-security-policy"));
      expect(await data.json()).toEqual({ ok: true });
      const timeline = await fetch(`${film}/__film/timeline.mjs`, { headers: own });
      expect(timeline.status).toBe(200);
      expect(timeline.headers.get("content-security-policy")).toContain(`, connect-src ${place} `);
      await timeline.text();
      // 编码页只许跑自己的脚本、读截图和这个文件夹下的声音
      const encoder = await fetch(`${film}/__encoder.html`, { headers: own });
      expect(encoder.status).toBe(200);
      expect(encoder.headers.get("content-security-policy")).toBe(`default-src 'none'; script-src 'unsafe-inline'; connect-src ${place} data:`);
      await encoder.text();
      // 找不到的文件也带策略，嵌进页面也借不到没有策略的窗口
      const missing = await fetch(`${film}/pages/p1/nope.txt`, { headers: own });
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-security-policy")).toContain(`, connect-src ${place} `);
      await missing.text();
      // 解析库拆视频的临时地址也不用配对（地址里的随机串就是凭证），猜错的照样找不到
      const look = await fetch(`${base}/v1/analyses/look/${"0".repeat(32)}/file`, { headers: own });
      expect(look.status).toBe(404);
      await look.arrayBuffer();
    }
  });
});
