import React, { useMemo, useRef, useState } from "react";

import type { EditKeyframe, EditMediaSegment, EditSegment } from "../../services/aiEdit";
import {
  KEYFRAME_CURVES, MAX_SPEED_POINTS, SPEED_CURVES, SPEED_POINT_RANGE, curveSource, curveSpeedAt, seqOf, type KeyframeCurve, type SpeedPoint,
} from "./aiEditCurves";
import { KEYFRAME_NAMES, secondMark, spokenDuration } from "./aiEditModel";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

// 详情卡里的两块曲线（剪映的「曲线变速」和「关键帧曲线」）：点预设直接套上；拖曲线上的点、控制柄，松手提交一次（一步撤销）。
// 只在网页里画（和数值框一样用 DOM），拖动时先画草稿，提交回来再换成工程里的样子。

type Run = (args: Record<string, unknown>) => Promise<boolean>;

// ---------- 曲线变速 ----------

const SPEED_KEYS = ["none", ...Object.keys(SPEED_CURVES)];
const SPEED_VIEW = { width: 260, height: 112, left: 30, right: 8, top: 8, bottom: 8 };
const LOG_MIN = Math.log10(SPEED_POINT_RANGE[0]);
const LOG_MAX = Math.log10(SPEED_POINT_RANGE[1]);
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** 视频片段的曲线变速：一排预设，套上以后能拖速度点（横着是素材里的位置，竖着是倍速，按对数画，1 倍在中间） */
export function SpeedCurveEditor({ segment, blocked, run }: { segment: EditMediaSegment; blocked: string | null; run: Run }) {
  const curve = segment.curve_speed ?? null;
  const [draft, setDraft] = useState<SpeedPoint[] | null>(null);
  const points = draft ?? curve?.points ?? null;
  const active = curve ? Object.keys(SPEED_CURVES).find((key) => SPEED_CURVES[key]!.name === curve.name) ?? "custom" : "none";
  const commit = async (next: SpeedPoint[]) => {
    setDraft(next);
    await run({ preset: active === "none" ? "custom" : active, points: next.map((point) => ({ x: round(point.x, 4), y: round(point.y, 3) })) });
    setDraft(null);
  };
  const { width: W, height: H, left: L, right: R, top: T, bottom: B } = SPEED_VIEW;
  const px = (x: number) => L + x * (W - L - R);
  const py = (speed: number) => T + (1 - (Math.log10(speed) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * (H - T - B);
  const svg = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ index: number; moved: boolean } | null>(null);
  /** 指针位置换成（素材位置、倍速） */
  const at = (event: { clientX: number; clientY: number }) => {
    const rect = svg.current!.getBoundingClientRect();
    const scale = rect.width / W;
    const x = Math.min(1, Math.max(0, ((event.clientX - rect.left) / scale - L) / (W - L - R)));
    const t = 1 - ((event.clientY - rect.top) / scale - T) / (H - T - B);
    const speed = 10 ** (LOG_MIN + Math.min(1, Math.max(0, t)) * (LOG_MAX - LOG_MIN));
    return { x, y: Math.min(SPEED_POINT_RANGE[1], Math.max(SPEED_POINT_RANGE[0], speed)) };
  };
  const moveTo = (list: SpeedPoint[], index: number, spot: SpeedPoint): SpeedPoint[] => list.map((point, i) => {
    if (i !== index) return point;
    // 两头的点只能上下挪；中间的夹在左右两点之间
    const x = i === 0 ? 0 : i === list.length - 1 ? 1 : Math.min(list[i + 1]!.x - 0.01, Math.max(list[i - 1]!.x + 0.01, spot.x));
    return { x, y: spot.y };
  });
  const path = useMemo(() => {
    if (!points) return "";
    // 倍速在成片时间上走直线：按成片时间取样，画在素材位置上
    return Array.from({ length: 81 }, (_, i) => i / 80).map((u, i) => `${i ? "L" : "M"}${px(curveSource(points, u)).toFixed(1)},${py(curveSpeedAt(points, u)).toFixed(1)}`).join("");
  }, [points]);

  const average = points ? 1 / seqOf(points).factor : 1;
  const lengthUs = points ? segment.source.duration_us * seqOf(points).factor : segment.timeline.duration_us;
  return <div style={css.block}>
    <div style={css.title}>曲线变速</div>
    <div style={css.chips}>
      {SPEED_KEYS.map((key) => <Chip key={key} label={key === "none" ? "无" : SPEED_CURVES[key]!.name} on={key === active} blocked={blocked}
        title={key === "none" ? "去掉曲线，按现在的平均倍速匀速放（时长不变）" : `套上「${SPEED_CURVES[key]!.name}」：素材截取不变，片段时长按曲线重算`}
        onPress={() => { if (key !== active) void run({ preset: key }); }} />)}
    </div>
    {points ? <>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} style={{ ...css.graph, cursor: blocked ? "default" : "crosshair" }} aria-label="曲线变速的速度点"
        onDoubleClick={(event) => {
          if (blocked || event.target !== event.currentTarget || points.length >= MAX_SPEED_POINTS) return;
          const spot = at(event);
          const index = points.findIndex((point) => point.x > spot.x);
          if (index <= 0 || spot.x - points[index - 1]!.x < 0.01 || points[index]!.x - spot.x < 0.01) return;
          void commit([...points.slice(0, index), spot, ...points.slice(index)]);
        }}>
        {[10, 1, 0.1].map((speed) => <g key={speed}>
          <line x1={L} x2={W - R} y1={py(speed)} y2={py(speed)} stroke={color.border} strokeDasharray={speed === 1 ? "3 3" : undefined} pointerEvents="none" />
          <text x={L - 4} y={py(speed) + 3} textAnchor="end" style={css.axis}>{speed}x</text>
        </g>)}
        <path d={path} fill="none" stroke={color.accentAction} strokeWidth={1.6} pointerEvents="none" />
        {points.map((point, index) => <circle key={index} cx={px(point.x)} cy={py(point.y)} r={4.5} fill={color.surface} stroke={color.accentAction} strokeWidth={1.6}
          style={{ cursor: blocked ? "default" : index === 0 || index === points.length - 1 ? "ns-resize" : "move", touchAction: "none" }}
          onPointerDown={(event) => {
            if (blocked || event.button !== 0) return;
            event.preventDefault();
            drag.current = { index, moved: false };
            svg.current?.setPointerCapture?.(event.pointerId);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (blocked || index === 0 || index === points.length - 1 || points.length <= 2) return;
            void commit(points.filter((_, i) => i !== index));
          }} />)}
      </svg>
      <PointerTracker svg={svg} drag={drag} onMove={(event) => {
        const state = drag.current!;
        state.moved = true;
        setDraft(moveTo(draft ?? curve!.points, state.index, at(event)));
      }} onUp={() => {
        const state = drag.current;
        drag.current = null;
        if (state?.moved && draft) void commit(draft);
      }} onCancel={() => { drag.current = null; setDraft(null); }} />
      <div style={css.note}>平均 {round(average, 2)} 倍，片段约 {spokenDuration(lengthUs)}。拖点调快慢，双击空白加点，双击点删掉</div>
    </> : null}
    {blocked ? <div style={css.note}>{blocked}</div> : null}
  </div>;
}

/** 拖点时的移动、松手挂在整张图上（按下时图捕获了指针，拖出点外也跟着走） */
function PointerTracker({ svg, drag, onMove, onUp, onCancel }: {
  svg: React.RefObject<SVGSVGElement | null>; drag: React.RefObject<unknown>;
  onMove: (event: PointerEvent) => void; onUp: () => void; onCancel: () => void;
}) {
  const handlers = useRef({ onMove, onUp, onCancel });
  handlers.current = { onMove, onUp, onCancel };
  React.useEffect(() => {
    const element = svg.current;
    if (!element) return undefined;
    const move = (event: PointerEvent) => { if (drag.current) handlers.current.onMove(event); };
    const up = () => { if (drag.current) handlers.current.onUp(); };
    const cancel = () => { if (drag.current) handlers.current.onCancel(); };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", cancel);
    return () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancel);
    };
  }, [svg, drag]);
  return null;
}

// ---------- 关键帧曲线 ----------

const CURVE_KEYS = ["linear", ...Object.keys(KEYFRAME_CURVES), "custom"];
const CURVE_VIEW = { width: 160, height: 120, pad: 10, low: -0.5, high: 1.5 };
const sameCurve = (a: readonly number[], b: readonly number[]) => a.every((value, i) => Math.abs(value - b[i]!) < 1e-6);
const curveKey = (curve: readonly number[] | undefined) => (!curve ? "linear" : Object.keys(KEYFRAME_CURVES).find((key) => sameCurve(KEYFRAME_CURVES[key]!.curve, curve)) ?? "custom");
const curveName = (key: string) => (key === "linear" ? "匀速" : key === "custom" ? "自定义" : KEYFRAME_CURVES[key]!.name);

interface Interval { property: string; from: EditKeyframe; to: EditKeyframe }

/** 片段上每两个相邻关键帧之间是一段：选一段，点预设或拖两个控制柄改它怎么走 */
export function KeyframeCurveEditor({ segment, blocked, run }: { segment: EditSegment; blocked: string | null; run: Run }) {
  const intervals = useMemo(() => {
    const byProperty = new Map<string, EditKeyframe[]>();
    for (const item of segment.keyframes ?? []) byProperty.set(item.property, [...(byProperty.get(item.property) ?? []), item]);
    return [...byProperty].flatMap(([property, frames]) => {
      const sorted = [...frames].sort((a, b) => a.offset_us - b.offset_us);
      return sorted.slice(1).map((to, i): Interval => ({ property, from: sorted[i]!, to }));
    });
  }, [segment.keyframes]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [draft, setDraft] = useState<KeyframeCurve | null>(null);
  const idOf = (item: Interval) => `${item.property}@${item.from.offset_us}`;
  const current = intervals.find((item) => idOf(item) === chosen) ?? intervals[0];
  const svg = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ handle: 0 | 1; moved: boolean } | null>(null);
  if (!current) return null;

  const saved = current.from.curve ?? null;
  const shown: KeyframeCurve = draft ?? saved ?? [0, 0, 1, 1];
  const active = draft ? "custom" : curveKey(saved ?? undefined);
  const send = async (args: Record<string, unknown>) => run({ property: current.property, offset: current.from.offset_us / 1_000_000, ...args });
  const commit = async (curve: KeyframeCurve) => {
    setDraft(curve);
    await send({ curve: "custom", bezier: curve.map((value) => round(value, 4)) });
    setDraft(null);
  };
  const { width: W, height: H, pad: P, low, high } = CURVE_VIEW;
  const px = (x: number) => P + x * (W - 2 * P);
  const py = (y: number) => P + (1 - (y - low) / (high - low)) * (H - 2 * P);
  const at = (event: PointerEvent): [number, number] => {
    const rect = svg.current!.getBoundingClientRect();
    const scale = rect.width / W;
    const x = Math.min(1, Math.max(0, ((event.clientX - rect.left) / scale - P) / (W - 2 * P)));
    const y = low + (1 - ((event.clientY - rect.top) / scale - P) / (H - 2 * P)) * (high - low);
    // 控制柄留在画得到的范围里（-0.5 到 1.5，够做回弹）
    return [x, Math.min(high, Math.max(low, y))];
  };
  const [x1, y1, x2, y2] = shown;
  const time = (item: EditKeyframe) => secondMark(segment.timeline.start_us + item.offset_us);
  return <div style={css.block}>
    <div style={css.title}>关键帧曲线</div>
    <div style={css.list} role="listbox" aria-label="关键帧之间的每一段">
      {intervals.map((item) => {
        const on = idOf(item) === idOf(current);
        return <div key={idOf(item)} role="option" aria-selected={on} onClick={() => { setChosen(idOf(item)); setDraft(null); }}
          style={{ ...css.interval, ...(on ? css.intervalOn : null) }}>
          <span style={css.intervalName}>{KEYFRAME_NAMES[item.property] ?? item.property}</span>
          <span style={css.intervalTime}>{time(item.from)}→{time(item.to).replace(/^第 /u, "")}</span>
          <span style={css.intervalCurve}>{curveName(curveKey(item.from.curve))}</span>
        </div>;
      })}
    </div>
    <div style={css.chips}>
      {CURVE_KEYS.map((key) => <Chip key={key} label={curveName(key)} on={key === active} blocked={blocked}
        title={key === "custom" ? "拖下面的两个控制柄自己调" : `这一段改成${curveName(key)}`}
        onPress={() => { if (key !== "custom" && key !== active) void send({ curve: key }); }} />)}
    </div>
    <div style={css.bezierRow}>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} style={{ ...css.graph, maxWidth: 220 }} aria-label="这一段的曲线">
        <rect x={px(0)} y={py(1)} width={px(1) - px(0)} height={py(0) - py(1)} fill="none" stroke={color.border} />
        <line x1={px(0)} y1={py(0)} x2={px(x1)} y2={py(y1)} stroke={color.textMuted} />
        <line x1={px(1)} y1={py(1)} x2={px(x2)} y2={py(y2)} stroke={color.textMuted} />
        <path d={`M${px(0)},${py(0)} C${px(x1)},${py(y1)} ${px(x2)},${py(y2)} ${px(1)},${py(1)}`} fill="none" stroke={color.accentAction} strokeWidth={1.8} />
        {([[x1, y1], [x2, y2]] as const).map(([x, y], handle) => <circle key={handle} cx={px(x)} cy={py(y)} r={5} fill={color.surface} stroke={color.accentAction} strokeWidth={1.6}
          style={{ cursor: blocked ? "default" : "move", touchAction: "none" }}
          onPointerDown={(event) => {
            if (blocked || event.button !== 0) return;
            event.preventDefault();
            drag.current = { handle: handle as 0 | 1, moved: false };
            svg.current?.setPointerCapture?.(event.pointerId);
          }} />)}
      </svg>
      <PointerTracker svg={svg} drag={drag} onMove={(event) => {
        const state = drag.current as { handle: 0 | 1; moved: boolean };
        state.moved = true;
        const [x, y] = at(event);
        setDraft(state.handle === 0 ? [x, y, shown[2], shown[3]] : [shown[0], shown[1], x, y]);
      }} onUp={() => {
        const state = drag.current as { moved: boolean } | null;
        drag.current = null;
        if (state?.moved && draft) void commit(draft);
      }} onCancel={() => { drag.current = null; setDraft(null); }} />
      <div style={css.note}>
        {KEYFRAME_NAMES[current.property] ?? current.property}从 {round(current.from.value, 2)} 到 {round(current.to.value, 2)}。横着是时间，竖着是走了多少，曲线陡的地方动得快；控制柄拉出框外会冲过头
      </div>
    </div>
    {blocked ? <div style={css.note}>{blocked}</div> : null}
  </div>;
}

function Chip({ label, title, on, blocked, onPress }: { label: string; title: string; on: boolean; blocked: string | null; onPress: () => void }) {
  return <button type="button" title={blocked ?? title} aria-pressed={on} aria-disabled={blocked ? true : undefined}
    onMouseDown={(event) => event.preventDefault()} onClick={() => { if (!blocked) onPress(); }}
    style={{ ...css.chip, ...(on ? css.chipOn : null), ...(blocked ? css.chipBlocked : null) }}>{label}</button>;
}

const css: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: 6, paddingTop: 8, borderTop: `1px solid ${color.borderSoft}` },
  title: { color: color.textSecondary, fontFamily: font.body, fontSize: 11.5, fontWeight: 600 },
  chips: { display: "flex", flexWrap: "wrap", gap: 4 },
  chip: {
    // 边框用长写：选中时只换颜色，取消时 React 删掉 borderColor 不会连带清掉简写里的颜色
    height: 22, padding: "0 7px", borderRadius: radius.small, borderWidth: 1, borderStyle: "solid", borderColor: color.border, background: color.surface,
    color: color.text, fontFamily: font.body, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap",
  },
  chipOn: { borderColor: color.accentAction, color: color.accentAction, fontWeight: 600 },
  chipBlocked: { opacity: 0.45, cursor: "default" },
  graph: { display: "block", width: "100%", height: "auto", borderRadius: radius.small, background: color.surfaceRaised, border: `1px solid ${color.border}`, userSelect: "none" },
  axis: { fill: color.textMuted, fontFamily: font.body, fontSize: 9 },
  note: { color: color.textMuted, fontFamily: font.body, fontSize: 10.5, lineHeight: "15px" },
  list: { display: "flex", flexDirection: "column", maxHeight: 112, overflowY: "auto", border: `1px solid ${color.border}`, borderRadius: radius.small },
  interval: { display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 7px", cursor: "pointer", fontFamily: font.body, fontSize: 11, color: color.text },
  intervalOn: { background: color.accentSoft },
  intervalName: { flexShrink: 0, minWidth: 48, color: color.textSecondary },
  intervalTime: { flex: 1, minWidth: 0, color: color.textMuted, fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  intervalCurve: { flexShrink: 0 },
  bezierRow: { display: "flex", flexDirection: "column", gap: 6 },
};
