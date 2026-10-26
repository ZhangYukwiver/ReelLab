const { contextBridge, ipcRenderer } = require("electron");

// 页面能用的桌面能力只有这些：本机服务的地址和配对码、应用更新、取走别的应用送来的视频
contextBridge.exposeInMainWorld("desktopRuntime", Object.freeze({
  getServerConfig: () => ipcRenderer.invoke("desktop:get-server-config"),
  getAppUpdateState: () => ipcRenderer.invoke("desktop:get-app-update-state"),
  checkForAppUpdates: () => ipcRenderer.invoke("desktop:check-for-app-updates"),
  downloadAppUpdate: () => ipcRenderer.invoke("desktop:download-app-update"),
  installAppUpdate: () => ipcRenderer.invoke("desktop:install-app-update"),
  onAppUpdateState: (listener) => {
    if (typeof listener !== "function") return () => undefined;
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("desktop:app-update-state", handler);
    return () => ipcRenderer.removeListener("desktop:app-update-state", handler);
  },
  // 取走并清空：送来的视频只交给页面一次
  takeHandoffs: () => ipcRenderer.invoke("desktop:take-handoffs"),
  onHandoffs: (listener) => {
    if (typeof listener !== "function") return () => undefined;
    const handler = () => listener();
    ipcRenderer.on("desktop:handoffs", handler);
    return () => ipcRenderer.removeListener("desktop:handoffs", handler);
  },
}));
