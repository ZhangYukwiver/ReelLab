import { Platform } from "react-native";

import type { AppStyle } from "../../services/appStyle";
import { aiCss } from "./aiCss";
import { minimalCss } from "./minimalCss";
import { motionCss } from "./motion";

/**
 * 只有极简一套：白底、发丝灰线、系统字体，墨黑做选中、一种蓝做数据和可点的东西。
 * web 上每个 token 是 CSS 变量（见 ensureThemeStyles），组件里拿到的是 var(--ws-…)；
 * minimalCss 和 aiCss 的版式层挂在 <html data-style="minimal"> 下（见 applyAppStyle）。
 * 绿 / 琥珀 / 红只在状态上出现；不铺纹理、不发光、不投影。
 */
const minimal = {
  canvas: "#FFFFFF",
  sidebar: "#FAFAFA",
  surface: "#FFFFFF",
  surfaceRaised: "#FAFAFA",
  surfaceMuted: "#F4F4F5",
  border: "#E4E4E7",
  borderSoft: "#EFEFF1",
  frame: "#D4D4D8",
  text: "#18181B",
  textSecondary: "#3F3F46",
  // #71717A 在白底上约 4.8:1，小字也够读
  textMuted: "#71717A",
  accent: "#18181B",
  accentPressed: "#000000",
  accentAction: "#2563EB",
  accentSoft: "#F1F1F3",
  figure: "#18181B",
  cyan: "#2563EB",
  cyanSoft: "#EEF3FE",
  green: "#15803D",
  greenSoft: "#EBF6EE",
  amber: "#B45309",
  amberSoft: "#FDF4E6",
  danger: "#C9372C",
  dangerSoft: "#FCEDEB",
  white: "#FFFFFF",
  black: "#18181B",
  scrim: "rgba(24,24,27,0.28)",
  button: "#18181B",
  buttonText: "#FFFFFF",
  signal: "#15803D",
  shadow: "none",
};

export type WorkspacePalette = typeof minimal;

// 整页一种系统无衬线，数字用等宽数位（见 minimalCss）；不取任何网络字体
const minimalSans = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', 'Segoe UI', 'Microsoft YaHei', sans-serif";
const minimalFonts = { serif: minimalSans, didot: minimalSans, body: minimalSans, sans: minimalSans, mono: minimalSans };
const minimalRadii = { small: 6, medium: 10, large: 12, pill: 999 };

export const palettes: Record<AppStyle, { colors: WorkspacePalette; fonts: typeof minimalFonts; radii: typeof minimalRadii }> = {
  minimal: { colors: minimal, fonts: minimalFonts, radii: minimalRadii },
};

const web = Platform.OS === "web";
const cssName = (key: string, index?: number) => `--ws-${key.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`)}${index === undefined ? "" : `-${index}`}`;

function colorTokens(palette: WorkspacePalette): WorkspacePalette {
  if (!web) return palette;
  return Object.fromEntries(Object.entries(palette).map(([key, value]) => [
    key,
    Array.isArray(value) ? value.map((_, index) => `var(${cssName(key, index)})`) : `var(${cssName(key)})`,
  ])) as WorkspacePalette;
}

export const workspaceColors = colorTokens(minimal);

export const workspaceFonts: Record<keyof typeof minimalFonts, string | undefined> = web
  ? { serif: "var(--ws-font-serif)", didot: "var(--ws-font-didot)", body: "var(--ws-font-body)", sans: "var(--ws-font-sans)", mono: "var(--ws-font-mono)" }
  : { serif: undefined, didot: undefined, body: undefined, sans: undefined, mono: undefined };

export const workspaceRadii: Record<keyof typeof minimalRadii, number | string> = web
  ? { small: "var(--ws-radius-small)", medium: "var(--ws-radius-medium)", large: "var(--ws-radius-large)", pill: "var(--ws-radius-pill)" }
  : minimalRadii;

// 带透明度的 token。RN-web 只放行以 `var(` 开头的颜色字符串，所以借一个从不定义的变量的回退值把 color-mix 送进 CSS。
export function alpha(token: string, ratio: number): string {
  if (!web) return `${token}${Math.round(ratio * 255).toString(16).padStart(2, "0")}`;
  return `var(--ws-unset, color-mix(in srgb, ${token} ${Math.round(ratio * 100)}%, transparent))`;
}

function declarations(style: AppStyle): string {
  const { colors, fonts, radii } = palettes[style];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(colors)) {
    if (Array.isArray(value)) value.forEach((item, index) => lines.push(`${cssName(key, index)}:${item}`));
    else lines.push(`${cssName(key)}:${value}`);
  }
  for (const [key, value] of Object.entries(fonts)) lines.push(`${cssName(`font-${key}`)}:${value}`);
  for (const [key, value] of Object.entries(radii)) lines.push(`--ws-radius-${key}:${value}px`);
  return lines.join(";");
}

export function themeCss(): string {
  return `:root{${declarations("minimal")}}\nhtml,body{background:var(--ws-canvas)}\n${motionCss}\n${minimalCss}\n${aiCss}`;
}

const STYLE_ID = "reellab-theme";

export function ensureThemeStyles(doc: Document | undefined = globalThis.document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = themeCss();
  doc.head.appendChild(style);
}
