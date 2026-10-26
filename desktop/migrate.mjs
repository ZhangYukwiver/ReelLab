import { constants } from "node:fs";
import { access, cp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { renameRetrying } from "../server/aiEdit/rename.mjs";

// 老数据迁移：AI 视频工作台原来是内容数据工作台里的一块，数据在 <appData>/内容数据工作台/collector/ 下。
// 拆片工坊第一次启动（<data>/ai-edit 还不存在）时把 ai-edit/、local-ai/、analyses.json 拷过来。只拷不删，只迁一次（拷完写标记文件）。
// 工程、会话、素材索引里存的是素材的绝对路径，拷过来的 .json 里把旧根目录换成新根目录。API Key 存在旧应用页面里，迁不了，要重填。

// ai-edit 排最后：新目录里有 ai-edit 就当迁过了，所以它要等别的都挪好才挪过去
const ENTRIES = ["local-ai", "analyses.json", "ai-edit"];
const MARKER = "migrated-from-legacy.json";
const exists = (target) => access(target).then(() => true, () => false);
const escapeJson = (text) => JSON.stringify(text).slice(1, -1);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * 把文本里的旧根目录换成新根目录：原样写的、JSON 转义一层的（Windows 的反斜杠成了 \\）、转义两层的
 * （会话历史里工具参数本身是一段 JSON 字符串）都换。只换整段目录，后面得跟着分隔符、引号或结尾，/x/collector-2 这种不动。
 */
export function rewriteRoot(text, from, to) {
  let result = text;
  for (const depth of [2, 1, 0]) {
    let source = from;
    let target = to;
    for (let level = 0; level < depth; level += 1) {
      source = escapeJson(source);
      target = escapeJson(target);
    }
    result = result.replace(new RegExp(`${escapeRegExp(source)}(?=[\\\\/"]|$)`, "gu"), () => target);
  }
  return result;
}

async function jsonFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await jsonFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(target);
  }
  return files;
}

/**
 * legacyRoot：旧应用的服务数据目录；dataDirectory：拆片工坊的服务数据目录。onStart：真要开始拷之前调一下（拷得慢，好先告诉用户）。
 * 回 { migrated, copied }：这次拷了哪几项。新目录已经有 ai-edit、迁过一次、旧目录里没有 ai-edit 时什么都不做。
 * 出错照常抛出：调用方得在服务建出空的 ai-edit 之前决定重试还是放弃，不然以后再也不会迁。
 */
export async function migrateLegacyData({ legacyRoot, dataDirectory, onStart = () => {}, rename = renameRetrying }) {
  const skipped = { migrated: false, copied: [] };
  const staging = path.join(dataDirectory, ".migrating");
  // Windows 上刚拷完的文件可能正被杀毒扫描，删不掉就多试几次
  const clearStaging = () => rm(staging, { recursive: true, force: true, maxRetries: 10 });
  if (await exists(path.join(dataDirectory, MARKER))) return skipped;
  if (await exists(path.join(dataDirectory, "ai-edit"))) {
    // ai-edit 是最后挪的，它在就说明都挪完了，只是没来得及收尾
    await clearStaging().catch(() => {});
    return skipped;
  }
  if (!await exists(path.join(legacyRoot, "ai-edit"))) return skipped;
  onStart();
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  // 先拷进临时目录改好路径再挪过去：中途退出或出错时 ai-edit 还不在新目录，下次照样重迁（已经挪过去的项跳过）
  await clearStaging();
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const name of ENTRIES) {
    const source = path.join(legacyRoot, name);
    if (!await exists(source) || await exists(path.join(dataDirectory, name))) continue;
    // APFS 上是克隆，不占额外空间
    await cp(source, path.join(staging, name), { recursive: true, mode: constants.COPYFILE_FICLONE });
    copied.push(name);
  }
  // 素材库存的是 realpath 过的目录（macOS 的临时目录会多一层 /private），两种写法都换成新目录的 realpath
  const target = await realpath(dataDirectory);
  const roots = [...new Set([await realpath(legacyRoot), path.resolve(legacyRoot)])].sort((left, right) => right.length - left.length);
  for (const file of await jsonFiles(staging)) {
    const text = await readFile(file, "utf8");
    const next = roots.reduce((value, root) => rewriteRoot(value, root, target), text);
    if (next !== text) await writeFile(file, next, { mode: 0o600 });
  }
  for (const name of copied) await rename(path.join(staging, name), path.join(dataDirectory, name));
  // 到这里数据都挪好了，收尾出错不算失败：临时目录下次启动再删，没有标记也有 ai-edit 挡着
  await clearStaging().catch(() => {});
  await writeFile(path.join(dataDirectory, MARKER), JSON.stringify({ from: legacyRoot, copied, at: new Date().toISOString() }), { mode: 0o600 }).catch(() => {});
  return { migrated: true, copied };
}
