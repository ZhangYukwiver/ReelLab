import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import { alpha, palettes, themeCss, workspaceColors, workspaceRadii } from "./workspaceTheme";
import { HEAVY_WEIGHT_HASHES, minimalCss } from "./minimalCss";
import { aiCss } from "./aiCss";
import { fx, motionCss, ws } from "./motion";

// RN-web 自己的样式编译器：拿它现算字重原子类的类名，和 minimalCss 里写死的哈希核对（内部模块，没有类型声明）
// @ts-expect-error -- react-native-web 没给 StyleSheet/compiler 出 .d.ts
import { atomic as atomicUntyped } from "react-native-web/dist/cjs/exports/StyleSheet/compiler";
const atomic = atomicUntyped as (style: Record<string, unknown>) => [Record<string, unknown>, unknown];

describe("workspace theme", () => {
  it("exposes every token as a CSS variable on web", () => {
    expect(workspaceColors.canvas).toBe("var(--ws-canvas)");
    expect(workspaceColors.textSecondary).toBe("var(--ws-text-secondary)");
    expect(workspaceColors.borderSoft).toBe("var(--ws-border-soft)");
    expect(workspaceRadii.pill).toBe("var(--ws-radius-pill)");
  });

  it("writes the minimal palette on :root, then motion, the minimal layer and the AI layer last", () => {
    const css = themeCss();
    expect(css.startsWith(`:root{--ws-canvas:${palettes.minimal.colors.canvas}`)).toBe(true);
    expect(css).toContain("--ws-radius-pill:999px");
    expect(css.indexOf(motionCss)).toBeLessThan(css.indexOf(minimalCss));
    expect(css.endsWith(`${minimalCss}\n${aiCss}`)).toBe(true);
  });

  it("ships the minimal layout layer, every rule scoped under data-style=\"minimal\"", () => {
    expect(themeCss()).toContain(minimalCss);
    const rules = [...minimalCss.matchAll(/([^{};]+)\{([^{}]*)\}/gu)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
    expect(rules.length).toBeGreaterThan(30);
    // 按括号深度切逗号：:where(a, b:not(c)) 里的逗号不算分隔
    const split = (selector: string) => {
      const parts: string[] = [];
      let depth = 0;
      let start = 0;
      for (let index = 0; index < selector.length; index += 1) {
        const char = selector[index];
        if (char === "(") depth += 1;
        else if (char === ")") depth -= 1;
        else if (char === "," && depth === 0) {
          parts.push(selector.slice(start, index));
          start = index + 1;
        }
      }
      return [...parts, selector.slice(start)];
    };
    for (const { selector } of rules) {
      if (/^(?:[\d.]+%\s*,?\s*)+$|^(?:from|to)$/u.test(selector)) continue;
      for (const part of split(selector)) expect(part.trim().startsWith(':root[data-style="minimal"]')).toBe(true);
    }
    // 极简的语言：不发光、不铺渐变、没有投影（只有 none 和描边用的 inset 1px），字重不超过 600
    expect(minimalCss).not.toMatch(/gradient\(/u);
    expect(minimalCss).not.toContain("text-shadow");
    // 只看声明：选择器里认行内重字重的 [style*="font-weight: 700"] 不算
    expect(rules.map(({ body }) => body).join(";")).not.toMatch(/font-weight:\s*(?:[7-9]00|bold)/u);
    for (const [, value] of minimalCss.matchAll(/box-shadow:([^;!}]+)/gu)) expect(value!.trim()).toMatch(/^(?:none|inset 0 0 0 1px #[0-9A-F]{6})$/u);
    // 为衬线调的 700–900 字重在工作台里收成 600：RN-web 打包版的类名只有 r-<哈希>，不带属性名，
    // 所以按哈希段认，开发版和打包版两种类名都要写；RN-web 升级后哈希变了，这里会先报错
    for (const weight of ["700", "800", "900", "bold"] as const) {
      const className = String(atomic({ fontWeight: weight })[0].fontWeight);
      const hash = className.slice(className.lastIndexOf("-") + 1);
      expect(HEAVY_WEIGHT_HASHES[weight]).toBe(hash);
      expect(minimalCss).toContain(`.r-${hash}`);
      expect(minimalCss).toContain(`.r-fontWeight-${hash}`);
    }
    expect(minimalCss).not.toContain('[class*="r-');
  });

  it("gives the minimal style a white ground and no shadow", () => {
    const { colors } = palettes.minimal;
    expect(colors.canvas).toBe("#FFFFFF");
    expect(colors.shadow).toBe("none");
  });

  it("marks layout roles with data-ws only, next to the motion flags", () => {
    expect(ws("btn", false, "on")).toEqual({ dataSet: { ws: "btn on" } });
    expect(ws(null, undefined)).toEqual({ dataSet: {} });
    expect(fx({ hover: "raise", ws: "btn-sig" })).toEqual({ dataSet: { hover: "raise", ws: "btn-sig" } });
    expect(fx({ motion: "rise", i: 2 })).toEqual({ dataSet: { motion: "rise", i: "2" } });
  });

  it("keeps alpha colours in the form RN-web forwards untouched", () => {
    expect(alpha(workspaceColors.accent, 0.13)).toBe("var(--ws-unset, color-mix(in srgb, var(--ws-accent) 13%, transparent))");
  });
});

describe("aiCss", () => {
  it("只管 AI 剪辑和 AI 解析两页，拼在主题最后", () => {
    for (const block of aiCss.split("\n").filter((line) => line.includes("{") && !line.startsWith("@keyframes") && !line.startsWith("@media"))) {
      const selectors = block.slice(0, block.indexOf("{")).split(",");
      for (const selector of selectors) expect(selector).toMatch(/\[data-testid="(?:ai-edit|analysis)-workspace"\]/u);
    }
    expect(themeCss().endsWith(aiCss)).toBe(true);
  });
});
