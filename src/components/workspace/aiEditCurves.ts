// 关键帧曲线和曲线变速的算法，和本机服务的 server/aiEdit/curves.mjs 是同一份（那边的 curves.test.mjs 对着比）。
// 关键帧曲线 [x1, y1, x2, y2] 同 CSS cubic-bezier，记在一段的起点那一帧上；曲线变速的速度点 x 是在截取的素材里的位置（0–1），
// y 是那一刻的倍速，剪映引擎先把 x 换成成片里的位置（每一小段在成片里的长度 = 素材里的长度 ÷ 两头倍速的平均），倍速在成片时间上走直线。

export type KeyframeCurve = [number, number, number, number];
export interface SpeedPoint { x: number; y: number }

export const KEYFRAME_CURVES: Record<string, { name: string; curve: KeyframeCurve }> = {
  ease_in: { name: "缓入", curve: [0.42, 0, 1, 1] },
  ease_out: { name: "缓出", curve: [0.32, 0.94, 0.6, 1] },
  ease_in_out: { name: "缓入缓出", curve: [0.42, 0, 0.58, 1] },
  back: { name: "回弹", curve: [0.34, 1.56, 0.64, 1] },
};

export const SPEED_CURVES: Record<string, { name: string; points: Array<[number, number]> }> = {
  custom: { name: "自定义", points: [[0, 1], [0.25, 1], [0.5, 1], [0.75, 1], [1, 1]] },
  montage: { name: "蒙太奇", points: [[0, 0.9], [0.1, 0.9], [0.5, 6.8], [0.65, 0.3], [0.8, 1], [1, 1]] },
  hero: { name: "英雄时刻", points: [[0, 1], [0.05, 1], [0.35, 5.5], [0.45, 0.5], [0.55, 0.5], [0.65, 5.5], [0.95, 1], [1, 1]] },
  bullet: { name: "子弹时间", points: [[0, 5.2], [0.4, 5.2], [0.46, 0.5], [0.54, 0.5], [0.6, 5.2], [1, 5.2]] },
  jump_cut: { name: "跳接", points: [[0, 0.6], [0.43, 0.6], [0.5, 6], [0.57, 0.6], [1, 0.6]] },
  flash_in: { name: "闪进", points: [[0, 5.2], [0.4, 5.2], [0.6, 1], [1, 1]] },
  flash_out: { name: "闪出", points: [[0, 1], [0.4, 1], [0.6, 5.2], [1, 5.2]] },
};

export const SPEED_POINT_RANGE: [number, number] = [0.1, 10];
export const MAX_SPEED_POINTS = 30;
export const CURVE_Y_RANGE: [number, number] = [-3, 4];

export const speedPreset = (key: string): SpeedPoint[] => (SPEED_CURVES[key]?.points ?? []).map(([x, y]) => ({ x, y }));

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const bez = (p1: number, p2: number, t: number) => 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3;

function paramAt(x1: number, x2: number, u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (bez(x1, x2, mid) < u) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 这一段走到时间 u（0–1）时走了多少（0–1，回弹会超出）。没有曲线是直线。 */
export function easeAt(curve: readonly number[] | null | undefined, u: number): number {
  if (!curve) return u;
  const [x1 = 0, y1 = 0, x2 = 1, y2 = 1] = curve;
  return bez(y1, y2, paramAt(x1, x2, u));
}

/** 速度点在成片里的位置（0–1）和成片时长 / 素材时长（factor）。 */
export function seqOf(points: readonly SpeedPoint[]): { seq: number[]; factor: number } {
  const seq = [0];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += (points[i]!.x - points[i - 1]!.x) / ((points[i]!.y + points[i - 1]!.y) / 2);
    seq.push(total);
  }
  return { seq: seq.map((value) => value / total), factor: total };
}

/** 成片走到 u（0–1）时放到素材的哪儿（0–1）。 */
export function curveSource(points: readonly SpeedPoint[], u: number): number {
  const { seq, factor } = seqOf(points);
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let i = 1;
  while (i < seq.length - 1 && seq[i]! < u) i += 1;
  const a = points[i - 1]!;
  const b = points[i]!;
  const span = seq[i]! - seq[i - 1]!;
  const d = u - seq[i - 1]!;
  return Math.min(1, a.x + factor * (a.y * d + (span > 0 ? ((b.y - a.y) * d * d) / (2 * span) : 0)));
}

/** 成片走到 u 时的倍速。 */
export function curveSpeedAt(points: readonly SpeedPoint[], u: number): number {
  const { seq } = seqOf(points);
  if (u <= 0) return points[0]!.y;
  if (u >= 1) return points[points.length - 1]!.y;
  let i = 1;
  while (i < seq.length - 1 && seq[i]! < u) i += 1;
  const span = seq[i]! - seq[i - 1]!;
  return span > 0 ? lerp(points[i - 1]!.y, points[i]!.y, (u - seq[i - 1]!) / span) : points[i]!.y;
}

/** 套上这条曲线后片段在时间线上大约多长（微秒，给面板显示；本机服务算的可能差 1 微秒）：素材截取长度 × factor。 */
export const curveDurationUs = (points: readonly SpeedPoint[], sourceUs: number) => Math.round(sourceUs * seqOf(points).factor);
