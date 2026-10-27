## v0.1.1

- Mac 上网页片段和导出的 MP4 改用这台电脑上的 Chrome / Edge 渲染，不再随机出现整帧空白，写网页片段时也不会再误报「重画一次就不一样」。没装 Chrome / Edge 的照旧用应用自己渲染。
- 修好导出 MP4 时，素材从头用到尾的音频或视频会报「ends past the file's length」、整片导不出来。
- 修好导出的片子在两段首尾相接的地方偶尔冒出一帧黑帧。

## 安装

**macOS（Apple Silicon）**：下载 `ReelLab-<版本>-arm64.dmg`，把「ReelLab」拖进「应用程序」。安装包没有开发者签名，首次打开前要在终端执行一次：

```bash
xattr -cr "/Applications/ReelLab.app"
```

不执行会提示应用已损坏。Mac 版没法在应用里自动安装更新，每个新版本都按这个步骤手动替换。

**Windows**：下载 `ReelLab-Setup-<版本>.exe` 安装。出现 SmartScreen 提示时，点「更多信息」，再点「仍要运行」。之后的新版本可以直接在应用里更新。
