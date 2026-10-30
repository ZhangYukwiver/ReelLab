import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, session, shell, Tray } from "electron";
import electronUpdater from "electron-updater";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromeProvider, findBrowser } from "../server/aiEdit/film/browser.mjs";
import { startServer } from "../server/server.mjs";
import { createAppUpdateController } from "./appUpdater.mjs";
import { electronFilmProvider } from "./filmWindow.mjs";
import { createInbox } from "./inbox.mjs";
import { migrateLegacyData } from "./migrate.mjs";
import { startStaticServer } from "./staticServer.mjs";
import { isSameOriginUrl } from "./windowPolicy.mjs";

const APP_ID = "com.zhangyukwiver.reellab";
const APP_NAME = "SmartCut";
// ponytail: 改名前叫 ReelLab，数据目录和送件方的收件箱（docs/handoff.md）都认这个路径，不跟着改
const DATA_DIRECTORY_NAME = "ReelLab";
const WINDOW_TITLE = "拆片工坊";
const PROTOCOL = "reellab";
const RELEASES_URL = "https://github.com/ZhangYukwiver/SmartCut/releases/latest";
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(moduleDirectory, "..");
const ICON_PATH = path.join(projectDirectory, "build", "icon.png");
// 页面的设置（接口配置、看板偏好等）存在 localStorage 里，而 localStorage 按 origin（含端口）分开存：
// 端口每次随机的话，重启后就读不到上次的设置。所以页面服务优先用固定端口，绑不上（被占用、被系统保留）才退回随机端口。
const WEB_PORT = 47661;

let mainWindow = null;
let desktopRuntime = null;
let appUpdateController = null;
let updateInstallRequested = false;
let shutdownStarted = false;
let quitting = false;
let tray = null;
// 收件箱导好、页面还没取走的视频（页面挂载时 takeHandoffs 取一次，之后听 desktop:handoffs）
const pendingHandoffs = [];
// 通知对象被回收后点它就没反应了，显示期间留着引用
const liveNotifications = new Set();

const userDataDirectory = path.join(app.getPath("appData"), DATA_DIRECTORY_NAME);
mkdirSync(userDataDirectory, { recursive: true });
app.setPath("userData", userDataDirectory);
app.setPath("sessionData", userDataDirectory);
app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);

const inbox = createInbox({
  directory: path.join(userDataDirectory, "inbox"),
  importHandoff: (input) => desktopRuntime.server.importHandoff(input),
});

function openExternalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") void shell.openExternal(url.toString());
  } catch {
    // Ignore malformed or unsupported external URLs.
  }
}

// 窗口还没建好时不用管：建好就会显示
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function showNotification(body) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: WINDOW_TITLE, body });
  liveNotifications.add(notification);
  const release = () => liveNotifications.delete(notification);
  notification.on("click", () => { release(); showMainWindow(); });
  notification.on("close", release);
  notification.on("failed", release);
  notification.show();
}

// 第一次关窗时说一声还在托盘里，不然会以为关不掉或者已经退出了
function noticeTrayOnce() {
  const marker = path.join(app.getPath("userData"), "tray-notice-shown");
  if (existsSync(marker)) return;
  try {
    writeFileSync(marker, "");
  } catch {
    return;
  }
  showNotification(`窗口收进${process.platform === "darwin" ? "菜单栏" : "托盘"}了，剪辑、生成和解析在后台接着跑。要完全退出，在图标菜单里点「退出」。`);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 }));
  tray.setToolTip(WINDOW_TITLE);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开拆片工坊", click: showMainWindow },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]));
  // macOS 点图标本来就弹菜单；Windows 习惯左键直接打开窗口
  if (process.platform === "win32") tray.on("click", showMainWindow);
}

function createMainWindow(appUrl) {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: WINDOW_TITLE,
    icon: ICON_PATH,
    backgroundColor: "#F4F5F6",
    webPreferences: {
      preload: path.join(moduleDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 页面里的外链和导出 MP4 用的跨源 <a download> 都交给系统浏览器
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isSameOriginUrl(url, appUrl)) return;
    event.preventDefault();
    openExternalUrl(url);
  });
  window.once("ready-to-show", () => window.show());
  // 关窗只是收进托盘，剪辑长任务、生成视频、出 MP4 和解析在后台接着跑（截图拆视频要页面开着，隐藏的窗口也算开着）；
  // 真正退出走托盘菜单或 ⌘Q
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    // macOS 全屏时直接隐藏会留下一整块黑屏，先退出全屏再收起来
    if (window.isFullScreen()) {
      window.once("leave-full-screen", () => window.hide());
      window.setFullScreen(false);
    } else {
      window.hide();
    }
    noticeTrayOnce();
  });
  // Windows 关机、重启、注销时不能拦着关窗
  window.on("session-end", () => { quitting = true; });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  void window.loadURL(appUrl);
  return window;
}

// 收件箱清一遍：导好的交给页面（页面切到「解析」，模型配好了就直接开始解析），再把窗口叫到前台
async function receiveHandoffs() {
  // 服务还没起来时先不收，launch 起完服务会清一遍
  if (!desktopRuntime) return;
  let received;
  try {
    received = await inbox.drain();
  } catch (error) {
    console.error("收件箱没清成:", error);
    return;
  }
  if (!received.length) return;
  pendingHandoffs.push(...received);
  showMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:handoffs");
}

const isInboxUrl = (value) => typeof value === "string" && value.toLowerCase().startsWith(`${PROTOCOL}://`);

// 原来内容数据工作台里的 AI 视频工作台：第一次启动时把工程、素材、解析库拷过来（只拷不删，只迁一次）。
// 没拷成就让用户选重试还是先不导入：服务一起来、页面一读素材库就会建出空的 ai-edit，之后再也不会自动迁
async function importLegacyData(dataDirectory) {
  const legacyRoot = path.join(app.getPath("appData"), "内容数据工作台", "collector");
  for (;;) {
    try {
      const result = await migrateLegacyData({
        legacyRoot,
        dataDirectory,
        // 拷完才建窗口；Windows 上没有 APFS 克隆，素材多时要整份复制，先说一声
        onStart: () => showNotification("第一次打开，正在把旧版的剪辑工程、素材和解析记录导进来，素材多的话要等一会儿。"),
      });
      if (result.migrated) console.log(`已导入旧版数据: ${result.copied.join("、")}`);
      return;
    } catch (error) {
      console.error("旧版数据没导进来:", error);
      const { response } = await dialog.showMessageBox({
        type: "warning",
        title: WINDOW_TITLE,
        message: "旧版的剪辑工程和素材没导进来",
        detail: `${error instanceof Error ? error.message : String(error)}\n\n旧数据还在 ${legacyRoot}，没动过。可以先腾出磁盘空间、关掉占着这些文件的程序再重试；选「先不导入」的话，以后不会再自动导入。`,
        buttons: ["重试", "先不导入"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 0) return;
    }
  }
}

async function startDesktopRuntime() {
  const dataDirectory = path.join(app.getPath("userData"), "data");
  await importLegacyData(dataDirectory);
  const server = await startServer({
    port: 0,
    dataDirectory,
    // 网页片段、本机出片：有 Edge / Chrome 就用它无头画。应用的离屏窗口画 canvas 会随机截到空白帧：Windows 上 10-25 实测，
    // Mac 上 10-27 实测（整页 canvas 的动画约一半帧是空的，写 page 时还会报「重画一次就不一样」）。找不到浏览器时才用离屏窗口
    filmBrowser: findBrowser() ? chromeProvider() : electronFilmProvider({ BrowserWindow }),
  });
  try {
    const rootDirectory = path.join(projectDirectory, "dist");
    const web = await startStaticServer({ rootDirectory, port: WEB_PORT })
      .catch((error) => {
        // Windows 上端口落在 Hyper-V / WinNAT 保留段或被独占时报的是 EACCES，不只 EADDRINUSE；
        // 只认 listen 失败，dist 缺文件（ENOENT）这类错误照常抛出
        if (error?.syscall !== "listen") throw error;
        console.warn(`页面服务固定端口 ${WEB_PORT} 不可用（${error.code}），这次改用随机端口，设置不会跨重启保留`);
        return startStaticServer({ rootDirectory });
      });
    return { server, web };
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function stopDesktopRuntime() {
  if (!desktopRuntime) return;
  const runtime = desktopRuntime;
  desktopRuntime = null;
  await Promise.allSettled([runtime.web.close(), runtime.server.close()]);
}

// Windows 安装包装的时候也写了一遍、卸载时删掉（build/installer.nsh）；这里每次启动再写，装到别处、开发时也指对
function registerProtocol() {
  // 开发时（electron desktop/main.mjs）协议要指回 electron 和这个脚本，不然系统会打开不带脚本的 electron
  if (process.defaultApp) {
    if (process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

async function launch() {
  // macOS needs an app menu for ⌘Q and ⌘C/⌘V in text fields; Windows keeps no menu bar.
  Menu.setApplicationMenu(process.platform === "darwin"
    ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
    : null);
  registerProtocol();
  desktopRuntime = await startDesktopRuntime();
  // electron-updater must be created after Electron is ready. In development
  // we intentionally do not touch its singleton, so `npm run desktop` never
  // tries to read a missing app-update.yml.
  const updater = app.isPackaged && (process.platform === "win32" || process.platform === "darwin")
    ? electronUpdater.autoUpdater
    : null;
  if (updater && process.platform === "win32") {
    // 国内直连 GitHub 下一百多兆的安装包经常断。版本信息和 sha512 仍从 GitHub
    // 直连读取，只把安装包改走加速线路，下完 electron-updater 会按 sha512 校验。
    // ponytail: 写死一条第三方线路，失效就换一条
    session.fromPartition("electron-updater", { cache: false }).webRequest.onBeforeRequest(
      { urls: ["https://github.com/ZhangYukwiver/SmartCut/releases/download/*"] },
      ({ url }, callback) => callback(url.endsWith(".exe") ? { redirectURL: `https://gh-proxy.com/${url}` } : {}),
    );
  }
  appUpdateController = createAppUpdateController({
    updater,
    isPackaged: app.isPackaged,
    platform: process.platform,
    currentVersion: app.getVersion(),
    emit: (state) => {
      if (state.phase === "error") updateInstallRequested = false;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:app-update-state", state);
    },
    // Mac 包没有开发者签名，没法在应用里装更新，打开发布页手动下载
    openDownloadPage: process.platform === "darwin" ? () => openExternalUrl(RELEASES_URL) : null,
    beforeInstall: async () => {
      // The updater schedules app.quit() only after it has accepted the
      // downloaded installer. Stop the local services from before-quit so a
      // failed installer launch leaves the current session usable.
      updateInstallRequested = true;
    },
  });
  ipcMain.handle("desktop:get-server-config", () => ({
    baseUrl: desktopRuntime?.server.baseUrl,
    pairingCode: desktopRuntime?.server.getPairingCode(),
  }));
  ipcMain.handle("desktop:get-app-update-state", () => appUpdateController?.getState() ?? null);
  ipcMain.handle("desktop:check-for-app-updates", () => appUpdateController?.check() ?? null);
  ipcMain.handle("desktop:download-app-update", () => appUpdateController?.download() ?? null);
  ipcMain.handle("desktop:install-app-update", () => appUpdateController?.install() ?? false);
  ipcMain.handle("desktop:take-handoffs", () => pendingHandoffs.splice(0));
  mainWindow = createMainWindow(desktopRuntime.web.url);
  createTray();
  appUpdateController.start();
  // 没开着时被送来视频（冷启动），或者上次没收完的：起来先清一遍
  void receiveHandoffs();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  // Windows 上送来视频时系统再开一个实例，reellab://inbox 在它的 argv 里
  app.on("second-instance", (_event, argv) => {
    // 窗口要等导完旧数据、起好服务才建，这之前再点图标什么都不会出来
    if (!mainWindow && app.isReady()) showNotification("拆片工坊还在启动，好了窗口会自己出来。");
    showMainWindow();
    if (argv.some(isInboxUrl)) void receiveHandoffs();
  });
  // macOS 用 open-url 送地址（冷启动时比 ready 还早，那时服务没起来，launch 里会再清一遍）
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (isInboxUrl(url)) void receiveHandoffs();
  });
  // macOS 点程序坞图标把收进托盘的窗口叫回来
  app.on("activate", showMainWindow);

  app.whenReady().then(launch).catch((error) => {
    dialog.showErrorBox(WINDOW_TITLE, error instanceof Error ? error.message : "拆片工坊启动失败。");
    app.quit();
  });
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  quitting = true;
  if (shutdownStarted || !desktopRuntime) return;
  event.preventDefault();
  shutdownStarted = true;
  appUpdateController?.dispose();
  void stopDesktopRuntime().finally(() => {
    if (updateInstallRequested) app.quit();
    else app.exit(0);
  });
});
