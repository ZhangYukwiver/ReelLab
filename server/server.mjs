#!/usr/bin/env node

import { chmod, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createAiEdit } from "./aiEdit/index.mjs";
import { chromeProvider } from "./aiEdit/film/browser.mjs";
import { createAnalysisRoutes } from "./analysisRoutes.mjs";
import { createLocalAi } from "./localAi.mjs";

// 拆片工坊的本机服务：配对、鉴权，加上 AI 剪辑（aiEdit/）和解析库（analysisRoutes.mjs）的接口。
// 桌面版由 desktop/main.mjs 启动；也能单独跑（npm run server），页面用开发服务器连过来。

const DEFAULT_PORT = 4865;
const MAX_BODY_BYTES = 4 * 1024;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(moduleDirectory, "..");

function parseArguments(argv) {
  const options = { lan: false, port: DEFAULT_PORT, origins: [], help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--lan") options.lan = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--port") options.port = Number(argv[++index]);
    else if (argument === "--origin") options.origins.push(argv[++index]);
    else throw new Error(`未知参数: ${argument}`);
  }

  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65_535) {
    throw new Error("--port 必须是 1024 到 65535 之间的整数。");
  }
  if (options.origins.some((origin) => typeof origin !== "string" || !/^https?:\/\//u.test(origin))) {
    throw new Error("--origin 必须是完整的 http(s) 来源地址。");
  }
  return options;
}

function printHelp() {
  console.log(`用法: npm run server -- [选项]

选项:
  --port <端口>       本地 API 端口，默认 ${DEFAULT_PORT}
  --lan               允许同一局域网内的设备连接
  --origin <地址>     允许的 Web 来源；可重复指定
  -h, --help          显示帮助

默认只监听 127.0.0.1。要从别的设备连接时使用 --lan，并在防火墙中仅允许专用网络。`);
}

function localLanAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

function isLoopbackAddress(value) {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function constantTimeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

class PairingManager {
  constructor() {
    this.sessions = new Map();
    this.code = this.createCode();
    this.attempts = new Map();
  }

  createCode() {
    return String(randomInt(10_000_000, 100_000_000));
  }

  displayCode() {
    return this.code;
  }

  allowAttempt(address) {
    const now = Date.now();
    const recent = (this.attempts.get(address) ?? []).filter((timestamp) => now - timestamp < 60_000);
    recent.push(now);
    this.attempts.set(address, recent);
    return recent.length <= 5;
  }

  pair(code) {
    if (!constantTimeStringEqual(code, this.code)) return null;
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    this.code = this.createCode();
    return token;
  }

  authorize(header) {
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const token = header.slice(7);
    const expiry = this.sessions.get(token);
    if (!expiry || expiry <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    // 闲置 12 小时才过期：用着就一直有效
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    return true;
  }
}

function isAllowedOrigin(origin, explicitOrigins) {
  if (!origin) return true;
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/iu.test(origin)) return true;
  return explicitOrigins.includes(origin);
}

// 服务自己放出去的网页（AI 写的网页片段、导入的 openfilm 工程、编码页）：页面脚本是 AI 或别人写的，不许它们取配对码、
// 配对、调要配对的接口，不然能自己拿到 token 替用户点「生成」花钱。同源请求浏览器带 Sec-Fetch-Site: same-origin；
// 页面换个主机名打回来（127.0.0.1 ↔ localhost / [::1] / 局域网地址）时浏览器算 cross-site，但 Origin 的端口还是服务
// 自己的，也一样当成自己的页面。应用页面在 47661 端口或开发服务器上，和服务同在 127.0.0.1 监听，端口永远不会撞上；
// MCP 桥和测试这类 Node 客户端两个头都不带，不受影响。
function fromOwnPage(request, ownPort) {
  if (request.headers["sec-fetch-site"] === "same-origin") return true;
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !ownPort) return false;
  try {
    const { protocol, port } = new URL(origin);
    if (protocol !== "http:" && protocol !== "https:") return false;
    return Number(port || (protocol === "https:" ? 443 : 80)) === ownPort;
  } catch {
    return false;
  }
}

function applyHeaders(response, origin) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Access-Control-Allow-Private-Network", "true");
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const optional = (value) => (typeof value === "string" && value ? value : null);

/**
 * 启动本机服务。返回 { baseUrl, port, dataDirectory, getPairingCode(), importHandoff({ filePath, meta }), close() }。
 * importHandoff：桌面外壳收到别的应用送来的视频（desktop/inbox.mjs 校验过的 meta）后调它，复制进素材库，回 Handoff 交给页面。
 */
export async function startServer({
  lan = false,
  port = DEFAULT_PORT,
  origins = [],
  dataDirectory = path.join(projectDirectory, ".local-data"),
  // 网页片段逐帧渲染用的浏览器：桌面版传 Electron 的隐藏窗口（Windows 优先 Edge / Chrome），单独跑时用本机 Chrome / Edge
  filmBrowser = chromeProvider(),
} = {}) {
  const options = { lan, port, origins };
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700);
  // listen 之后才知道自己的地址，渲染浏览器从这里开网页片段
  let origin = null;
  // 本机的 Codex / Claude Code：AI 剪辑和解析库共用，关服务时把还在跑的 CLI 一起杀掉
  const localAi = createLocalAi({ dataDirectory });
  const aiEdit = createAiEdit({ dataDirectory, localAi, filmBrowser, getOrigin: () => origin });
  const analyses = await createAnalysisRoutes({ dataDirectory, localAi, media: (id) => aiEdit.videoFile(id) });
  const pairing = new PairingManager();
  const bindAddress = options.lan ? "0.0.0.0" : "127.0.0.1";

  const server = createServer(async (request, response) => {
    const requestOrigin = typeof request.headers.origin === "string" ? request.headers.origin : "";
    if (!isAllowedOrigin(requestOrigin, options.origins)) {
      applyHeaders(response, "");
      sendJson(response, 403, { error: "origin_not_allowed" });
      return;
    }
    applyHeaders(response, requestOrigin);

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        // PATCH：AI 剪辑设置里开关技能
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Max-Age": "600",
      });
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const ownPage = fromOwnPage(request, server.address()?.port);
    if (request.method === "GET" && url.pathname === "/v1/health") {
      sendJson(response, 200, { ok: true, version: 1, app: "reellab" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/pairing-code") {
      const remoteAddress = request.socket.remoteAddress ?? "unknown";
      if (!isLoopbackAddress(remoteAddress) || ownPage) {
        sendJson(response, 403, { error: "pairing_code_local_only" });
        return;
      }
      sendJson(response, 200, { code: pairing.displayCode() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/pair") {
      // 放在限次之前：页面乱试配对码也不占本机（和应用同一个地址）的尝试次数
      if (ownPage) {
        sendJson(response, 403, { error: "same_origin_not_allowed" });
        return;
      }
      const remoteAddress = request.socket.remoteAddress ?? "unknown";
      if (!pairing.allowAttempt(remoteAddress)) {
        sendJson(response, 429, { error: "too_many_attempts" });
        return;
      }
      try {
        const body = await readJsonBody(request);
        const token = pairing.pair(body.code);
        if (!token) {
          sendJson(response, 401, { error: "invalid_pairing_code" });
          return;
        }
        sendJson(response, 200, { token, expiresInSeconds: SESSION_TTL_MS / 1000 });
        console.log(`新的配对码: ${pairing.displayCode()}`);
      } catch {
        sendJson(response, 400, { error: "invalid_request" });
      }
      return;
    }

    // 不用配对的文件地址：AI 剪辑的素材文件给 <video>/<img> 直接用，带不了 Bearer，靠素材库的 key；
    // 解析库请页面拆视频时给 <video> 的临时地址，地址里的随机串就是凭证
    if (await aiEdit.handle(request, response, url)) return;
    if (await analyses.handle(request, response, url)) return;

    // 上面不用配对的文件地址照常给网页片段用；往下要配对的接口，服务自己放出去的页面就算拿到了 token 也不认
    if (ownPage) {
      sendJson(response, 403, { error: "same_origin_not_allowed" });
      return;
    }
    if (!pairing.authorize(request.headers.authorization)) {
      sendJson(response, 401, { error: "not_paired" });
      return;
    }

    // 页面拿它确认 token 还有效
    if (request.method === "GET" && url.pathname === "/v1/status") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (await aiEdit.handle(request, response, url, { paired: true })) return;
    if (await analyses.handle(request, response, url, { paired: true })) return;
    sendJson(response, 404, { error: "not_found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, bindAddress, resolve);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      analyses.close();
      await aiEdit.close();
      await localAi.close();
    } finally {
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      // 页面一直挂着会话长轮询，不掐断的话 close 会一直等下去，退出应用就卡住
      server.closeAllConnections();
      await closed;
    }
  };

  const address = server.address();
  if (!address || typeof address === "string") {
    await shutdown();
    throw new Error("本机服务未能分配 TCP 端口。");
  }
  origin = `http://127.0.0.1:${address.port}`;

  const importHandoff = async ({ filePath, meta }) => {
    const title = optional(meta?.title);
    const author = optional(meta?.author);
    const sourceUrl = optional(meta?.url);
    const item = await aiEdit.importFile(filePath, title ?? "送来的视频", {
      type: "handoff", ...(title ? { title } : {}), ...(author ? { author } : {}), ...(sourceUrl ? { url: sourceUrl } : {}),
    });
    const duration = Number.isFinite(meta?.durationSeconds) && meta.durationSeconds > 0 ? meta.durationSeconds : null;
    return {
      mediaId: item.id,
      title: title ?? item.name,
      author,
      url: sourceUrl,
      description: optional(meta?.description),
      durationSeconds: duration ?? (item.durationUs ? Math.round(item.durationUs / 100_000) / 10 : null),
    };
  };

  return {
    baseUrl: origin,
    port: address.port,
    dataDirectory,
    getPairingCode: () => pairing.displayCode(),
    importHandoff,
    close: shutdown,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const runtime = await startServer(options);
  console.log(`拆片工坊本机服务: ${runtime.baseUrl}`);
  if (options.lan) {
    for (const address of localLanAddresses()) console.log(`局域网地址: http://${address}:${runtime.port}`);
  }
  console.log(`配对码: ${runtime.getPairingCode()}`);
  console.log(`本地数据仅保存在: ${runtime.dataDirectory}`);

  process.once("SIGINT", () => void runtime.close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void runtime.close().then(() => process.exit(0)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "本机服务启动失败。");
    process.exitCode = 1;
  });
}
