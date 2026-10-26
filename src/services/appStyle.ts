/** 拆片工坊只有极简一套外观；类型留着，是给 workspaceTheme 的色板表和 applyAppStyle 用的 */
export type AppStyle = "minimal";

interface StyleDocument {
  documentElement: { dataset: Record<string, string | undefined> };
}

// 只在 web：minimalCss、aiCss 的版式层都挂在 <html data-style="minimal"> 下，不挂这一下它们一条也不生效。
export function applyAppStyle(style: AppStyle, doc: StyleDocument | undefined = globalThis.document as StyleDocument | undefined): void {
  if (!doc) return;
  doc.documentElement.dataset.style = style;
}
