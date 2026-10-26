import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

// 收件箱：别的应用把一条视频送来（约定见 docs/handoff.md）。发件方先放 <id>.mp4，再放 <id>.json（json 最后出现，有它才算放好），
// 然后用 reellab://inbox 叫醒拆片工坊；这里把放好的一对导进素材库，再删掉这一对。协议地址不带任何路径或参数，只认收件箱里的文件。

const READY = /^([0-9a-f]{32})\.json$/u;
// 只清这种名字的残留，收件箱里别的文件不碰
const LEFTOVER = /^[0-9a-f]{32}\.(?:mp4|json)(?:\.part)?$/u;
const MAX_META_BYTES = 64 * 1024;
const MAX_TEXT = 500;
const STALE_MS = 24 * 60 * 60 * 1000;

/** 字符串去首尾空白、最长 500 字；空串当没有。 */
function text(value) {
  const trimmed = value.trim().slice(0, MAX_TEXT);
  return trimmed || null;
}

/** 说明文件：类型不对（或不是 version 1）回 null，整对丢掉。可选字段可以缺、可以是 null。 */
export function parseHandoffMeta(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 || typeof value.title !== "string") return null;
  const meta = { title: text(value.title) };
  for (const key of ["author", "url", "description"]) {
    const field = value[key];
    if (field !== undefined && field !== null && typeof field !== "string") return null;
    meta[key] = typeof field === "string" ? text(field) : null;
  }
  // 原视频地址只给页面当链接用：不是 http(s) 的不要
  if (meta.url && !/^https?:\/\//iu.test(meta.url)) meta.url = null;
  const duration = value.durationSeconds;
  if (duration !== undefined && duration !== null && !(typeof duration === "number" && Number.isFinite(duration) && duration >= 0)) return null;
  meta.durationSeconds = typeof duration === "number" && duration > 0 ? duration : null;
  return meta;
}

/**
 * directory：收件箱目录；importHandoff({ filePath, meta })：导进素材库，回 Handoff（server.mjs 的 importHandoff）。
 * drain() 清一遍收件箱，回这次导好的 Handoff 列表；同时调多次会排队，同一对不会导两遍。
 * 导入失败（素材库满了、服务正在关）的一对先留着，下次再试；超过一天还在的连同孤零零的 .mp4、.part 一起删掉。
 */
export function createInbox({ directory, importHandoff, now = Date.now, log = (message, error) => console.error(message, error) }) {
  const remove = (name) => rm(path.join(directory, name), { force: true }).catch(() => undefined);

  const isFile = async (name) => {
    try {
      const info = await lstat(path.join(directory, name));
      return info.isFile() ? info : null;
    } catch {
      return null;
    }
  };

  const takeOne = async (id) => {
    const json = `${id}.json`;
    const video = `${id}.mp4`;
    const metaInfo = await isFile(json);
    if (!metaInfo || !(await isFile(video))) return null;
    let meta = null;
    if (metaInfo.size <= MAX_META_BYTES) {
      meta = parseHandoffMeta(await readFile(path.join(directory, json), "utf8").catch(() => ""));
    }
    if (!meta) {
      await remove(json);
      await remove(video);
      return null;
    }
    let handoff;
    try {
      handoff = await importHandoff({ filePath: path.join(directory, video), meta });
    } catch (error) {
      log("送来的视频没导进素材库，下次再试:", error);
      return null;
    }
    // 先删 json：删到一半退出的话剩下的 .mp4 只是孤儿，不会被当成放好的再导一遍
    await remove(json);
    await remove(video);
    return handoff;
  };

  const run = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const received = [];
    for (const name of await readdir(directory)) {
      const match = READY.exec(name);
      if (!match) continue;
      const handoff = await takeOne(match[1]);
      if (handoff) received.push(handoff);
    }
    for (const name of await readdir(directory)) {
      if (!LEFTOVER.test(name)) continue;
      // 还配着说明文件的视频按说明文件的时间算：发件方复制视频时可能留着原来的修改时间
      const paired = name.endsWith(".mp4") ? name.replace(/\.mp4$/u, ".json") : null;
      const info = (paired && await isFile(paired)) || await isFile(name);
      if (info && now() - info.mtimeMs > STALE_MS) await remove(name);
    }
    return received;
  };

  let queue = Promise.resolve();
  return {
    drain() {
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
