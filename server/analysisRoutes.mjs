import path from "node:path";

import { LIBRARY_TEXTS, createLookDesk } from "./aiEdit/look.mjs";
import { AnalysisError, AnalysisLibrary, parseAnalysisConfig, startAnalysis } from "./videoAnalysis.mjs";

// 解析库的接口，写法照 aiEdit/index.mjs：server.mjs 在配对校验前后各调一次 handle。
// 校验前只回页面拆视频用的临时文件地址（<video> 带不了 Bearer，地址里的随机串就是凭证，半小时失效），校验后（paired: true）处理其余接口。

const BODY_BYTES = 16 * 1024;
// 页面交回拆好的截图和节拍、压缩好的视频（base64，最大约 45MB 的 mp4）
const LOOK_BODY_BYTES = 96 * 1024 * 1024;
const ENTRY = /^\/v1\/analyses\/[0-9a-f-]{36}$/u;
const LOOK_ANSWER = /^\/v1\/analyses\/[0-9a-f-]{36}\/look\/[0-9a-f]{16}$/u;
const LOOK_FILE = /^\/v1\/analyses\/look\/([0-9a-f]{32})\/file$/u;

function sendJson(response, status, payload) {
  if (response.headersSent || response.destroyed) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

async function readJson(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

/**
 * dataDirectory：服务数据目录（解析库存在它下面的 analyses.json）；localAi：本机的 Codex / Claude Code；
 * media(mediaId)：从 AI 剪辑素材库取要解析的视频，回 { filePath, item }，没有或不是视频时抛带 code / status 的错。
 */
export async function createAnalysisRoutes({ dataDirectory, localAi = null, media }) {
  const library = new AnalysisLibrary(path.join(dataDirectory, "analyses.json"));
  await library.load();
  // 解析库用的模型看不了视频时，请解析库页面在浏览器里拆截图和节拍
  const looks = createLookDesk({ filePath: "/v1/analyses/look", texts: LIBRARY_TEXTS });

  const route = async (request, response, url) => {
    const { pathname } = url;
    if (pathname === "/v1/analyses/looks") {
      // 应用开着就接活儿：只回挂着的拆视频任务（不带整份解析结果，轮询很轻）
      if (request.method !== "GET") { sendJson(response, 405, { error: "method_not_allowed" }); return; }
      sendJson(response, 200, { looks: library.list().filter((item) => item.status === "running" && item.look).map((item) => ({ id: item.id, look: item.look })) });
    } else if (LOOK_ANSWER.test(pathname)) {
      // 解析库页面交回拆好的截图和节拍、压缩好的视频，或接手、进度回执
      if (request.method !== "POST") { sendJson(response, 405, { error: "method_not_allowed" }); return; }
      const [, , , id, , jobId] = pathname.split("/");
      looks.answer(id, jobId, await readJson(request, LOOK_BODY_BYTES));
      sendJson(response, 200, { ok: true });
    } else if (pathname === "/v1/analyses" && request.method === "GET") {
      sendJson(response, 200, { analyses: library.list() });
    } else if (pathname === "/v1/analyses" && request.method === "POST") {
      // 解析素材库里的一条视频：{ mediaId, config, video? }
      const body = await readJson(request, BODY_BYTES);
      if (typeof body?.mediaId !== "string") throw new AnalysisError("invalid_request", "要先把视频放进素材库，再拿素材来解析。");
      const config = parseAnalysisConfig(body.config);
      const video = body.video && typeof body.video === "object" && !Array.isArray(body.video) ? body.video : null;
      sendJson(response, 202, { analysis: await startAnalysis({ library, media, mediaId: body.mediaId, video, config, looks, localAi }) });
    } else if (ENTRY.test(pathname) && request.method === "DELETE") {
      sendJson(response, 200, { removed: await library.remove(pathname.split("/").at(-1)) });
    } else if (pathname === "/v1/analyses" || ENTRY.test(pathname)) {
      sendJson(response, 405, { error: "method_not_allowed" });
    } else {
      sendJson(response, 404, { error: "not_found" });
    }
  };

  return {
    async handle(request, response, url, { paired = false } = {}) {
      const { pathname } = url;
      if (pathname !== "/v1/analyses" && !pathname.startsWith("/v1/analyses/")) return false;
      const lookFile = request.method === "GET" ? pathname.match(LOOK_FILE) : null;
      if (lookFile) {
        await looks.sendFile(request, response, lookFile[1]);
        return true;
      }
      if (!paired) return false;
      try {
        await route(request, response, url);
      } catch (error) {
        const known = typeof error?.code === "string" && Number.isInteger(error?.status);
        const malformed = error instanceof SyntaxError || error?.message === "body_too_large";
        sendJson(response, known ? error.status : malformed ? 400 : 500, {
          error: known ? error.code : malformed ? "invalid_request" : "analysis_failed",
          message: known ? error.message : malformed ? "请求无效，请重试。" : "解析没开始，请稍后重试。",
        });
      }
      return true;
    },

    close() { looks.close(); },
  };
}
