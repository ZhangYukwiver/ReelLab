/**
 * 极简风格的版式层：只挂在 :root[data-style="minimal"] 下。
 * 颜色、字体、圆角由 token 给（workspaceTheme 的 minimal），这里只做“少”：
 * - 白底、1px 发丝线分区，没有外框、投影、纹理、发光、渐变；
 * - 一种系统无衬线，字重只有 400 / 500 / 600，中文不拉字距，数字等宽；
 * - 墨黑是选中和主按钮，蓝只给可点的字和聚焦；
 * - 悬停不抬、不放大，只换底色。
 * 按 data-ws 角色选，声明一律 !important 压过 RN-web 的原子类和行内样式。
 */
const M = ':root[data-style="minimal"]';
const INK = "#18181B";
const TEXT2 = "#3F3F46";
const MUTE = "#71717A";
const FAINT = "#A1A1AA";
const LINE = "#E4E4E7";
const RAIL = "#F4F4F5";
const SIDE = "#FAFAFA";
const WHITE = "#FFFFFF";
const BLUE = "#2563EB";
const SANS = "var(--ws-font-body)";

/** 选中带某个角色的元素；"a b" 表示同一元素同时带 a 和 b。多个用逗号分开。 */
function sel(roles: string, suffix = ""): string {
  return roles.split(",").map((group) => `${M} ${group.trim().split(/\s+/u).map((role) => `[data-ws~="${role}"]`).join("")}${suffix}`).join(",");
}
const rule = (selector: string, body: string) => `${selector}{${body}}`;

// 工作台本体和它弹出的对话框
const SCOPES = ['[data-testid="app-shell"]', '[data-ws~="e-modal"]'];
/** 工作台里的任意后代；:where 把优先级压到最低，按角色写的规则总能盖过它。 */
const within = (inner: string) => `${M} :where(${SCOPES.flatMap((scope) => inner.split("|").map((part) => `${scope} ${part}`)).join(",")})`;

/** 字号、字重、颜色；中文一律不拉字距。 */
const type = (size: number, weight = 400, tone?: string, line?: number) => [
  `font-size:${size}px!important`, `font-weight:${weight}!important`, "letter-spacing:0!important",
  ...(tone ? [`color:${tone}!important`] : []), ...(line ? [`line-height:${line}px!important`] : []),
].join(";");
/** 一块区域里用 token 上色的图标和字统一成一个颜色（按钮、选中项、占位图标）。 */
const tint = (tone: string) => [
  `--ws-text:${tone}`, `--ws-text-secondary:${tone}`, `--ws-text-muted:${tone}`, `--ws-figure:${tone}`,
  `--ws-accent:${tone}`, `--ws-cyan:${tone}`, `--ws-green:${tone}`, `--ws-amber:${tone}`,
  `--ws-white:${tone}`, `--ws-black:${tone}`, `--ws-canvas:${tone}`, `--ws-button-text:${tone}`,
].join(";");
const line = (edge: "top" | "bottom" | "left" | "right", tone = LINE) => `border-${edge}:1px solid ${tone}!important`;
const notDisabled = ':not([aria-disabled="true"])';
const TRANSITION = "transition:background-color .14s ease,border-color .14s ease,color .14s ease!important";

/**
 * 组件里为衬线体调的 700 / 800 / 900 / bold。RN-web 把字重编成原子类：开发版叫 r-fontWeight-<哈希>，
 * 打包版（expo export）只剩 r-<哈希>，哈希段两边一样（murmurhash("fontWeight" + 值)），所以两种类名都写上，
 * 不能按 r-fontWeight- 前缀去匹配。哈希由测试拿 RN-web 自己的 compiler 现算核对，RN-web 升级后对不上会报错。
 */
export const HEAVY_WEIGHT_HASHES = { "700": "b88u0q", "800": "1vr29t4", "900": "ovu0ai", bold: "vw2c0b" } as const;
const HEAVY = [
  ...Object.values(HEAVY_WEIGHT_HASHES).flatMap((hash) => [`.r-${hash}`, `.r-fontWeight-${hash}`]),
  // 不走 StyleSheet 的写法会落成行内 style
  ...Object.keys(HEAVY_WEIGHT_HASHES).map((weight) => `[style*="font-weight: ${weight}"]`),
].join("|");

const blocks: string[] = [
  // ---------- 底子 ----------
  // 段落最后一行别只剩一两个字（「就行。」「存好。」）：text-wrap 会继承，挂在 body 上整页一起生效
  rule(`${M} body`, "-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;text-wrap:pretty"),
  // 700 以上的字重一律收成 600（见 HEAVY）；中文不拉字距，工作台里的字一律归零，不靠类名认
  rule(within(HEAVY), "font-weight:600!important"),
  rule(within("[dir]|[dir] *"), "letter-spacing:0!important"),
  rule(`${within("*")}::selection`, `background:#DBEAFE;color:${INK}`),
  rule(`${within(":focus-visible")}`, `outline:2px solid ${BLUE}!important;outline-offset:2px!important`),
  rule(within("input|textarea"), `caret-color:${BLUE}`),

  // ---------- 动效：悬停不抬不放大，只换底色；进场只淡入；不发光、不脉冲 ----------
  rule(`${M} [data-hover]`, TRANSITION),
  rule(`${M} [data-hover] svg`, "transition:none!important;transform:none!important"),
  rule(`${M} [data-hover="lift"]:hover,${M} [data-hover="card"]:hover,${M} [data-hover="raise"]:hover`, "transform:none!important;box-shadow:none!important"),
  rule(`${M} [data-hover="tint"]:hover`, `background-color:${RAIL}!important`),
  rule(`${M} [data-motion="rise"],${M} [data-reveal="in"],${M} [data-motion="pop"]`, "animation-name:ws-fade!important;animation-duration:.24s!important;animation-timing-function:ease-out!important"),
  rule(`${M} [data-motion="pulse"]`, "animation:none!important"),
  // 极简不放完成时迸开的小点，只留对勾淡入
  rule(`${M} [data-motion="burst"]`, "animation:none!important"),

  // ---------- 外壳：没有外框，发丝线分开 ----------
  rule(`${M} [data-testid="app-shell"]`, `padding:0!important;background-color:${WHITE}!important`),

  // 顶栏：名字、页签和右边的按钮
  rule(sel("w-top"), `height:56px!important;min-height:56px!important;${line("bottom")};background-color:${WHITE}!important`),
  rule(sel("w-title"), `${type(18, 600, INK)};font-family:${SANS}!important`),

  // ---------- 按钮：主 = 墨黑实底，次 = 白底发丝线，方钮 32px ----------
  rule(sel("btn,btn-solid"), `border-radius:8px!important;border-width:1px!important;border-style:solid!important;box-shadow:none!important;transform:none!important;${TRANSITION}`),
  rule(sel("btn"), `background-color:${WHITE}!important;border-color:${LINE}!important;${tint(TEXT2)};--ws-text:${INK}`),
  rule(sel("btn", " [dir]"), type(13, 500, INK)),
  rule(sel("btn", `${notDisabled}:hover`), `background-color:${RAIL}!important`),
  rule(sel("btn-solid"), `background-color:${INK}!important;border-color:${INK}!important;${tint(WHITE)}`),
  rule(sel("btn-solid", " [dir]"), type(13, 500, WHITE)),
  rule(sel("btn-solid", `${notDisabled}:hover`), "background-color:#27272A!important"),
  rule(sel("btn small"), "border-radius:6px!important;padding-top:5px!important;padding-bottom:5px!important"),
  rule(sel("btn small", " [dir]"), type(12, 500, INK)),
  rule(sel("btn square"), `width:32px!important;height:32px!important;min-height:32px!important;padding:0!important`),
  rule(`${sel("btn on")},${sel("btn small on")},${sel("btn square on")}`, `background-color:${INK}!important;border-color:${INK}!important;${tint(WHITE)}`),
  rule(`${sel("btn on", " [dir]")},${sel("btn small on", " [dir]")}`, `color:${WHITE}!important`),

  // svg 里的字没设字体时会落到浏览器默认的衬线体
  rule(`${M} [data-testid="app-shell"] svg text`, `font-family:${SANS}`),

  // ---------- AI 剪辑的对话：气泡、输入框、发送钮 ----------
  rule(sel("c-bubble"), "border-radius:12px!important"),
  rule(sel("c-bubble in"), `border:1px solid ${LINE}!important;background-color:${WHITE}!important;border-top-left-radius:4px!important`),
  rule(sel("c-bubble own"), `border:1px solid ${RAIL}!important;background-color:${RAIL}!important;border-top-right-radius:4px!important`),
  rule(sel("c-bubble", " [dir]"), "font-size:13px!important;line-height:20px!important"),
  rule(sel("c-composer"), `background-color:${WHITE}!important;${line("top")}`),
  rule(sel("c-input"), `border:1px solid ${LINE}!important;border-radius:8px!important;background-color:${WHITE}!important;font-size:13px!important;outline:none!important;${TRANSITION}`),
  rule(sel("c-input", ":focus"), `border-color:${FAINT}!important`),
  rule(sel("c-send"), `width:36px!important;height:36px!important;border-radius:8px!important;background-color:${RAIL}!important;${TRANSITION}`),
  rule(sel("c-send on"), `background-color:${INK}!important`),

  // ---------- 面板和页签 ----------
  rule(sel("e-box"), `border:1px solid ${LINE}!important;border-radius:12px!important;box-shadow:none!important;background-color:${WHITE}!important`),
  rule(sel("e-tab"), `${tint(MUTE)};${TRANSITION}`),
  rule(sel("e-tab on"), `border-bottom-color:${INK}!important;${tint(INK)}`),
  rule(sel("e-section"), `${type(16, 600, INK)};font-family:${SANS}!important`),
  rule(sel("cr-note"), "font-size:12px!important;letter-spacing:0!important"),
  // 选中的面板：上面 e-box 那条把边框和底色统一掉了，补回墨黑描边
  rule(sel("e-box on"), `border-color:${INK}!important;background-color:${SIDE}!important`),

  // ---------- 对话框：一圈发丝线，没有投影 ----------
  rule(sel("e-modal"), `border:1px solid ${LINE}!important;border-radius:12px!important;box-shadow:none!important;background-color:${WHITE}!important`),
];

export const minimalCss = blocks.join("\n");
