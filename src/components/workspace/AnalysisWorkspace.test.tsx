import { describe, expect, it, vi } from "vitest";

// 只测导出的纯函数；整页依赖的 react-native、图标在 Node 里换成 RN-web 和空组件，好把文件加载进来
// @ts-expect-error -- react-native-web 没给 .d.ts
vi.mock("react-native", async () => await import("react-native-web"));
vi.mock("lucide-react-native", () => new Proxy({}, { has: () => true, get: (_target, key) => (key === "then" ? undefined : () => null) }));

import type { VideoAnalysis } from "../../services/videoAnalysis";
import { videoOf } from "./AnalysisWorkspace";

const entry = (video: VideoAnalysis["video"], sourceUrl: string | null = null): VideoAnalysis => ({
  id: "a", mediaId: "m1", sourceUrl, status: "complete", stage: null, video, model: "seed", markdown: "# 拆解", error: null,
  createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z",
});

describe("重新解析带回上次的视频说明", () => {
  it("标题、作者、地址、简介、时长都带回去，服务端不会把它们覆盖成空", () => {
    const video = { title: "做饭", author: "小王", url: "https://example.com/v/1", description: "三分钟一道菜", durationSeconds: 12.5 };
    expect(videoOf(entry(video, video.url))).toEqual(video);
  });

  it("没有的字段不带", () => {
    expect(videoOf(entry({ title: "片子", author: null, durationSeconds: null, description: null }))).toEqual({ title: "片子" });
    expect(videoOf(entry(null))).toEqual({});
  });
});
