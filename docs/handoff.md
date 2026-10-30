# 送件约定

别的应用（目前是内容数据工作台）把一条视频交给拆片工坊，走「收件箱目录 + 自定义协议」：
发件方把文件放进收件箱，再用 `reellab://inbox` 叫醒拆片工坊；拆片工坊把收件箱里的东西导进素材库。
协议地址只是个提醒，不带任何路径或参数，拆片工坊只认收件箱里的文件。

## 收件箱

`<appData>/ReelLab/inbox/`，`appData` 就是 Electron 的 `app.getPath("appData")`
（macOS `~/Library/Application Support`，Windows `%APPDATA%`）。拆片工坊的 userData 也在 `<appData>/ReelLab`。

## 发件方怎么放

1. `id` 取 32 位小写十六进制随机串。
2. 视频复制成 `<id>.mp4.part`，写完改名 `<id>.mp4`。只收 mp4。
3. 说明写成 `<id>.json.part`，写完改名 `<id>.json`。**json 最后出现**，有 json 才算放好了：

   ```json
   {
     "version": 1,
     "title": "视频标题",
     "author": "作者名或 null",
     "url": "原视频页面地址或 null",
     "description": "视频简介或 null",
     "durationSeconds": 12.3,
     "sentAt": "2026-10-26T02:00:00.000Z"
   }
   ```

4. `shell.openExternal("reellab://inbox")`。
5. 放之前先用 `app.getApplicationNameForProtocol("reellab://")` 看装没装；返回空串就是没装，不往收件箱写，
   提示用户去 https://github.com/ZhangYukwiver/SmartCut/releases/latest 下载。

## 拆片工坊怎么收

- 注册 `reellab` 协议；启动后、`open-url`（macOS）、`second-instance`（Windows，argv 里带 `reellab://`）时都把收件箱清一遍。
- 只处理名字是 `^[0-9a-f]{32}\.json$`、旁边有同名 `.mp4` 的；json 超过 64KB 或字段类型不对就丢掉。
  字符串去首尾空白、最长 500 字。
- 导进素材库（来源 `{ type: "handoff", title, author, url }`），然后删掉这一对文件；
  孤零零的 `.mp4`、`.part` 超过一天也删。
- 导好后把窗口叫到前台，交给页面：页面切到「解析」，模型已经配好就直接开始解析（和原来在内容数据工作台里点「解析」一样），
  没配好就把视频摆在那里等用户配。
