import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";
import { Download, RefreshCw } from "lucide-react-native";

import { AiEditWorkspace } from "./src/components/workspace/AiEditWorkspace";
import { AnalysisWorkspace } from "./src/components/workspace/AnalysisWorkspace";
import { usePendingLooks } from "./src/components/workspace/aiEditLook";
import { Segmented, SmallButton } from "./src/components/workspace/CreatorKit";
import { ws } from "./src/components/workspace/motion";
import { ensureThemeStyles, workspaceColors as color, workspaceFonts as font } from "./src/components/workspace/workspaceTheme";
import { applyAppStyle } from "./src/services/appStyle";
import { connectServer, setTokenRenewal, type Connection } from "./src/services/connection";
import {
  appUpdateAction,
  downloadDesktopUpdate,
  getDesktopServerConfig,
  getDesktopUpdateState,
  installDesktopUpdate,
  subscribeDesktopHandoffs,
  subscribeDesktopUpdateState,
  takeDesktopHandoffs,
  type DesktopUpdateState,
  type Handoff,
} from "./src/desktopRuntime";

// 拆片工坊的外壳：顶栏（名字、两个页签、连接状态、有新版时的更新按钮）+ 当前页签。
// 桌面版一打开就用外壳给的配对码连上自带的本机服务；浏览器里开发时连 http://127.0.0.1:4865，服务对本机页面直接给配对码。

type WorkbenchView = "aiEdit" | "analysis";
const TABS: Array<{ label: string; value: WorkbenchView }> = [{ label: "AI 剪辑", value: "aiEdit" }, { label: "AI 解析", value: "analysis" }];

export default function App() {
  const [view, setView] = useState<WorkbenchView>("aiEdit");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [connectError, setConnectError] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const connectingRef = useRef(false);
  const [appUpdate, setAppUpdate] = useState<DesktopUpdateState | null>(null);
  const updateBusyRef = useRef(false);
  // 别的应用送来、还没开始解析的视频，交给解析页处理
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);

  // 只有极简一套主题：首帧绘制前把 CSS 变量表和 <html data-style> 挂上，否则第一帧没有颜色
  useLayoutEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    ensureThemeStyles();
    applyAppStyle("minimal");
  }, []);

  const connect = useCallback(async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setConnecting(true);
    setConnectError(null);
    try {
      const next = await connectServer(await getDesktopServerConfig());
      tokenRef.current = next.token;
      setConnection(next);
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : "连不上本机服务。");
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  }, []);
  useEffect(() => { void connect(); }, [connect]);

  // 配对闲置过期（电脑睡过一夜）时悄悄重新配对，正在发的请求换上新令牌重发
  const baseUrl = connection?.baseUrl ?? null;
  useEffect(() => {
    setTokenRenewal(async (expired) => {
      if (expired !== tokenRef.current) return null;
      const next = await connectServer(await getDesktopServerConfig(), baseUrl ?? undefined);
      if (expired !== tokenRef.current) return null;
      tokenRef.current = next.token;
      setConnection(next);
      return next.token;
    });
    return () => setTokenRenewal(null);
  }, [baseUrl]);

  // 模型看不了视频时，AI 剪辑和解析库要页面在浏览器里拆视频：应用开着就接，不管当前在哪个页签
  usePendingLooks(baseUrl, connection?.token ?? null);

  useEffect(() => {
    const unsubscribe = subscribeDesktopUpdateState(setAppUpdate);
    void getDesktopUpdateState().then((state) => { if (state) setAppUpdate(state); });
    return unsubscribe;
  }, []);
  const updateAction = appUpdateAction(appUpdate);
  const runUpdate = async () => {
    if (!updateAction || updateBusyRef.current) return;
    updateBusyRef.current = true;
    try {
      if (updateAction.kind === "install") await installDesktopUpdate();
      else {
        const state = await downloadDesktopUpdate();
        if (state) setAppUpdate(state);
      }
    } finally {
      updateBusyRef.current = false;
    }
  };

  // 送件：外壳已经把视频导进素材库了，这里取走说明、切到解析页。打开时取一次（冷启动叫醒的那批），之后每次外壳叫一声再取。
  // 不在卸载时作废：取走就清空了，开发时 StrictMode 先卸一次也不能把这批丢掉
  useEffect(() => {
    const take = async () => {
      const fresh = await takeDesktopHandoffs();
      if (!fresh.length) return;
      setHandoffs((current) => [...current, ...fresh.filter((item) => !current.some((other) => other.mediaId === item.mediaId))]);
      setView("analysis");
    };
    void take();
    return subscribeDesktopHandoffs(() => void take());
  }, []);
  const handoffDone = useCallback((mediaId: string) => setHandoffs((current) => current.filter((item) => item.mediaId !== mediaId)), []);

  const status = connection ? "已连接" : connecting ? "正在连接本机服务…" : connectError ?? "没连上本机服务";
  return <View testID="app-shell" style={styles.root}>
    <View {...ws("w-top")} style={styles.topbar}>
      <Text {...ws("w-title")} numberOfLines={1} style={styles.title}>拆片工坊</Text>
      <View style={styles.tabs}><Segmented small options={TABS} value={view} onChange={setView} /></View>
      <View style={styles.spacer} />
      <View accessibilityLiveRegion="polite" style={styles.status}>
        {connecting && !connection ? <ActivityIndicator size="small" color={color.textMuted} /> : <View style={[styles.dot, { backgroundColor: connection ? color.green : color.danger }]} />}
        <Text numberOfLines={1} style={[styles.statusText, !connection && !connecting && { color: color.danger }]}>{status}</Text>
      </View>
      {!connection && !connecting ? <SmallButton label="重试" onPress={() => void connect()}><RefreshCw size={13} color={color.text} /></SmallButton> : null}
      {updateAction ? <SmallButton label={updateAction.label} disabled={updateAction.disabled} onPress={() => void runUpdate()}><Download size={13} color={color.text} /></SmallButton> : null}
    </View>
    <View style={styles.body}>
      {view === "aiEdit"
        ? <AiEditWorkspace connection={connection} onReconnect={connect} />
        : <AnalysisWorkspace connection={connection} handoffs={handoffs} onHandoffDone={handoffDone} onReconnect={connect} />}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: "100%", backgroundColor: color.canvas },
  topbar: { height: 56, flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 24, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border },
  title: { color: color.text, fontFamily: font.sans, fontSize: 18, fontWeight: "600" },
  tabs: { alignSelf: "center" },
  spacer: { flex: 1 },
  status: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: 360 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { flexShrink: 1, color: color.textMuted, fontFamily: font.sans, fontSize: 12 },
  body: { flex: 1, minHeight: 0 },
});
