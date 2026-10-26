import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appUpdateAction,
  checkDesktopUpdates,
  downloadDesktopUpdate,
  getDesktopServerConfig,
  getDesktopUpdateState,
  installDesktopUpdate,
  subscribeDesktopHandoffs,
  subscribeDesktopUpdateState,
  takeDesktopHandoffs,
} from "./desktopRuntime";

// 测试跑在 node 里，没有 window；要模拟 Electron 预加载桥时临时挂一个
function withBridge(bridge: Record<string, unknown>) {
  vi.stubGlobal("window", { desktopRuntime: bridge });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("desktop update bridge", () => {
  it("is a no-op outside the Electron preload bridge", async () => {
    expect(await getDesktopUpdateState()).toBeNull();
    expect(await checkDesktopUpdates()).toBeNull();
    expect(await downloadDesktopUpdate()).toBeNull();
    expect(await installDesktopUpdate()).toBe(false);
    expect(() => subscribeDesktopUpdateState(() => undefined)).not.toThrow();
  });
});

describe("update button", () => {
  const state = (phase: string, extra: Record<string, unknown> = {}) => ({
    phase, currentVersion: "0.1.0", version: "0.2.0", releaseName: null, releaseDate: null, releaseNotes: null, progress: null,
    bytesPerSecond: null, transferred: null, total: null, message: "", error: null, checkedAt: null, manualDownload: false, ...extra,
  }) as Parameters<typeof appUpdateAction>[0];

  it("shows only when there is a new version to fetch or install", () => {
    expect(appUpdateAction(null)).toBeNull();
    for (const phase of ["idle", "checking", "up-to-date", "error", "unsupported"]) expect(appUpdateAction(state(phase))).toBeNull();
    expect(appUpdateAction(state("available"))).toEqual({ label: "下载更新", kind: "download", disabled: false });
    expect(appUpdateAction(state("available", { manualDownload: true }))).toEqual({ label: "去下载新版", kind: "download", disabled: false });
    expect(appUpdateAction(state("downloading", { progress: 42.6 }))).toEqual({ label: "正在下载更新 43%", kind: "download", disabled: true });
    expect(appUpdateAction(state("downloaded"))).toEqual({ label: "重启并安装", kind: "install", disabled: false });
  });
});

describe("server config bridge", () => {
  it("answers null in a browser and for a malformed answer", async () => {
    expect(await getDesktopServerConfig()).toBeNull();
    withBridge({ getServerConfig: async () => ({ baseUrl: "http://127.0.0.1:4866", pairingCode: "123" }) });
    expect(await getDesktopServerConfig()).toBeNull();
    withBridge({ getServerConfig: async () => { throw new Error("ipc failed"); } });
    expect(await getDesktopServerConfig()).toBeNull();
  });

  it("passes the shell's address and 8-digit pairing code through", async () => {
    withBridge({ getServerConfig: async () => ({ baseUrl: "http://127.0.0.1:4866", pairingCode: "12345678" }) });
    expect(await getDesktopServerConfig()).toEqual({ baseUrl: "http://127.0.0.1:4866", pairingCode: "12345678" });
  });
});

describe("handoff bridge", () => {
  it("is empty in a browser", async () => {
    expect(await takeDesktopHandoffs()).toEqual([]);
    expect(subscribeDesktopHandoffs(() => undefined)).toBeTypeOf("function");
  });

  it("keeps well-formed handoffs, fills missing optional fields with null and drops the rest", async () => {
    withBridge({
      takeHandoffs: async () => [
        { mediaId: "m1", title: "做饭", author: "阿珍", url: "https://example.com/v/1", description: "  ", durationSeconds: 12.5 },
        { mediaId: "m2", title: "" },
        { mediaId: "", title: "没有 id" },
        { title: "也没有 id" },
        "garbage",
        { mediaId: "m3", title: "负时长", durationSeconds: -1 },
      ],
    });
    expect(await takeDesktopHandoffs()).toEqual([
      { mediaId: "m1", title: "做饭", author: "阿珍", url: "https://example.com/v/1", description: null, durationSeconds: 12.5 },
      { mediaId: "m2", title: "", author: null, url: null, description: null, durationSeconds: null },
      { mediaId: "m3", title: "负时长", author: null, url: null, description: null, durationSeconds: null },
    ]);
  });

  it("treats a rejected call or a non-array answer as nothing sent", async () => {
    withBridge({ takeHandoffs: async () => { throw new Error("ipc failed"); } });
    expect(await takeDesktopHandoffs()).toEqual([]);
    withBridge({ takeHandoffs: async () => ({ mediaId: "m1", title: "x" }) });
    expect(await takeDesktopHandoffs()).toEqual([]);
  });

  it("subscribes through the bridge and hands back its unsubscribe", () => {
    const off = vi.fn();
    const onHandoffs = vi.fn(() => off);
    withBridge({ onHandoffs });
    const listener = () => undefined;
    const unsubscribe = subscribeDesktopHandoffs(listener);
    expect(onHandoffs).toHaveBeenCalledWith(listener);
    unsubscribe();
    expect(off).toHaveBeenCalled();
  });
});
