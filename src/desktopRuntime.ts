// 桌面外壳（desktop/preload.cjs）挂在 window.desktopRuntime 上的桥；浏览器里打开时没有，下面的函数都退回空值。

export interface DesktopServerConfig {
  baseUrl: string;
  pairingCode: string;
}

/** 别的应用送来、已经导进素材库的一条视频（见 docs/handoff.md） */
export interface Handoff {
  mediaId: string;
  title: string;
  author: string | null;
  url: string | null;
  description: string | null;
  durationSeconds: number | null;
}

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "error"
  | "unsupported";

export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  version: string | null;
  releaseName: string | null;
  releaseDate: string | null;
  releaseNotes: string | null;
  progress: number | null;
  bytesPerSecond: number | null;
  transferred: number | null;
  total: number | null;
  message: string;
  error: string | null;
  checkedAt: string | null;
  manualDownload: boolean;
}

interface DesktopRuntimeBridge {
  getServerConfig(): Promise<unknown>;
  getAppUpdateState(): Promise<unknown>;
  checkForAppUpdates(): Promise<unknown>;
  downloadAppUpdate(): Promise<unknown>;
  installAppUpdate(): Promise<unknown>;
  onAppUpdateState(listener: (value: unknown) => void): () => void;
  takeHandoffs(): Promise<unknown>;
  onHandoffs(listener: () => void): () => void;
}

declare global {
  interface Window {
    desktopRuntime?: DesktopRuntimeBridge;
  }
}

function getDesktopRuntime(): DesktopRuntimeBridge | null {
  return typeof window === "undefined" || !window.desktopRuntime ? null : window.desktopRuntime;
}

export async function getDesktopServerConfig(): Promise<DesktopServerConfig | null> {
  const runtime = getDesktopRuntime();
  if (!runtime) return null;
  try {
    const value = await runtime.getServerConfig();
    if (!value || typeof value !== "object") return null;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.baseUrl === "string" && /^\d{8}$/u.test(String(candidate.pairingCode))
      ? { baseUrl: candidate.baseUrl, pairingCode: String(candidate.pairingCode) }
      : null;
  } catch {
    return null;
  }
}

function parseDesktopUpdateState(value: unknown): DesktopUpdateState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const phases: DesktopUpdatePhase[] = ["idle", "checking", "available", "downloading", "downloaded", "up-to-date", "error", "unsupported"];
  if (typeof candidate.phase !== "string" || !phases.includes(candidate.phase as DesktopUpdatePhase)) return null;
  if (typeof candidate.currentVersion !== "string" || typeof candidate.message !== "string") return null;
  const nullableString = (key: string): string | null => typeof candidate[key] === "string" ? candidate[key] as string : null;
  const nullableNumber = (key: string): number | null => typeof candidate[key] === "number" && Number.isFinite(candidate[key]) ? candidate[key] as number : null;
  return {
    phase: candidate.phase as DesktopUpdatePhase,
    currentVersion: candidate.currentVersion,
    version: nullableString("version"),
    releaseName: nullableString("releaseName"),
    releaseDate: nullableString("releaseDate"),
    releaseNotes: nullableString("releaseNotes"),
    progress: nullableNumber("progress"),
    bytesPerSecond: nullableNumber("bytesPerSecond"),
    transferred: nullableNumber("transferred"),
    total: nullableNumber("total"),
    message: candidate.message,
    error: nullableString("error"),
    checkedAt: nullableString("checkedAt"),
    manualDownload: candidate.manualDownload === true,
  };
}

export async function getDesktopUpdateState(): Promise<DesktopUpdateState | null> {
  const runtime = getDesktopRuntime();
  if (!runtime) return null;
  try {
    return parseDesktopUpdateState(await runtime.getAppUpdateState());
  } catch {
    return null;
  }
}

export function subscribeDesktopUpdateState(listener: (state: DesktopUpdateState) => void): () => void {
  const runtime = getDesktopRuntime();
  if (!runtime) return () => undefined;
  try {
    const unsubscribe = runtime.onAppUpdateState((value) => {
      const state = parseDesktopUpdateState(value);
      if (state) listener(state);
    });
    return typeof unsubscribe === "function" ? unsubscribe : () => undefined;
  } catch {
    return () => undefined;
  }
}

export async function checkDesktopUpdates(): Promise<DesktopUpdateState | null> {
  const runtime = getDesktopRuntime();
  if (!runtime) return null;
  try {
    return parseDesktopUpdateState(await runtime.checkForAppUpdates());
  } catch {
    return null;
  }
}

export async function downloadDesktopUpdate(): Promise<DesktopUpdateState | null> {
  const runtime = getDesktopRuntime();
  if (!runtime) return null;
  try {
    return parseDesktopUpdateState(await runtime.downloadAppUpdate());
  } catch {
    return null;
  }
}

export async function installDesktopUpdate(): Promise<boolean> {
  const runtime = getDesktopRuntime();
  if (!runtime) return false;
  try {
    return (await runtime.installAppUpdate()) === true;
  } catch {
    return false;
  }
}

export interface AppUpdateAction {
  label: string;
  kind: "download" | "install";
  disabled: boolean;
}

/** 顶栏上的更新按钮：有新版就下载（或去发布页），下载中显示进度，下好了重启安装；没有可装的新版时不显示（null） */
export function appUpdateAction(state: DesktopUpdateState | null): AppUpdateAction | null {
  if (state?.phase === "available") return { label: state.manualDownload ? "去下载新版" : "下载更新", kind: "download", disabled: false };
  if (state?.phase === "downloading") return { label: state.progress === null ? "正在下载更新…" : `正在下载更新 ${Math.round(state.progress)}%`, kind: "download", disabled: true };
  if (state?.phase === "downloaded") return { label: "重启并安装", kind: "install", disabled: false };
  return null;
}

function parseHandoff(value: unknown): Handoff | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.mediaId !== "string" || !item.mediaId || typeof item.title !== "string") return null;
  const text = (key: string): string | null => typeof item[key] === "string" && (item[key] as string).trim() ? item[key] as string : null;
  const seconds = typeof item.durationSeconds === "number" && Number.isFinite(item.durationSeconds) && item.durationSeconds > 0 ? item.durationSeconds : null;
  return { mediaId: item.mediaId, title: item.title, author: text("author"), url: text("url"), description: text("description"), durationSeconds: seconds };
}

/** 取走外壳攒着的送件（取一次就清空）；浏览器里、没有送件时是空数组 */
export async function takeDesktopHandoffs(): Promise<Handoff[]> {
  const runtime = getDesktopRuntime();
  if (!runtime) return [];
  try {
    const value = await runtime.takeHandoffs();
    return Array.isArray(value) ? value.map(parseHandoff).filter((item): item is Handoff => item !== null) : [];
  } catch {
    return [];
  }
}

/** 外壳又收到送件时叫一声（不带内容，收到后自己去 takeDesktopHandoffs） */
export function subscribeDesktopHandoffs(listener: () => void): () => void {
  const runtime = getDesktopRuntime();
  if (!runtime) return () => undefined;
  try {
    const unsubscribe = runtime.onHandoffs(listener);
    return typeof unsubscribe === "function" ? unsubscribe : () => undefined;
  } catch {
    return () => undefined;
  }
}
