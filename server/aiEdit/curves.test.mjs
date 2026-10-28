import { describe, expect, it } from "vitest";

import * as board from "../../src/components/workspace/aiEditCurves";
import { KEYFRAME_CURVES, SPEED_CURVES, curveSource, curveSpeedAt, easeAt, seqOf, sliceSpeedCurve, speedPreset, splitCurve } from "./curves.mjs";

const STEPS = Array.from({ length: 21 }, (_, i) => i / 20);

describe("keyframe curves", () => {
  it("eases between the two values and keeps the ends", () => {
    expect(easeAt(null, 0.3)).toBe(0.3);
    for (const { curve } of Object.values(KEYFRAME_CURVES)) {
      expect(easeAt(curve, 0)).toBe(0);
      expect(easeAt(curve, 1)).toBe(1);
    }
    expect(easeAt(KEYFRAME_CURVES.ease_in_out.curve, 0.5)).toBeCloseTo(0.5, 9);
    expect(easeAt(KEYFRAME_CURVES.ease_in.curve, 0.5)).toBeLessThan(0.5);
    expect(easeAt(KEYFRAME_CURVES.ease_out.curve, 0.5)).toBeGreaterThan(0.5);
    // 回弹冲过头
    expect(Math.max(...STEPS.map((u) => easeAt(KEYFRAME_CURVES.back.curve, u)))).toBeGreaterThan(1);
  });

  it("splits a curve into two that move exactly like the whole", () => {
    for (const curve of [...Object.values(KEYFRAME_CURVES).map((item) => item.curve), [0.1, 0.8, 0.7, 0.2]]) {
      for (const cut of [0.25, 0.5, 0.8]) {
        const [head, tail] = splitCurve(curve, cut);
        const middle = easeAt(curve, cut);
        for (const u of STEPS) {
          const expected = easeAt(curve, u);
          const got = u <= cut ? middle * easeAt(head, u / cut) : middle + (1 - middle) * easeAt(tail, (u - cut) / (1 - cut));
          expect(got, `${curve} cut ${cut} at ${u}`).toBeCloseTo(expected, 6);
        }
      }
    }
    expect(splitCurve(null, 0.5)).toEqual([null, null]);
  });
});

describe("curve speed", () => {
  it("lays the points out on the timeline like the VE engine (transferTrimPointXtoSeqPointX)", () => {
    expect(seqOf(speedPreset("custom")).factor).toBeCloseTo(1, 12);
    expect(seqOf([{ x: 0, y: 2 }, { x: 1, y: 2 }]).factor).toBeCloseTo(0.5, 12);
    const points = speedPreset("flash_in");
    const { seq, factor } = seqOf(points);
    // 0.4 / 5.2 + 0.2 / 3.1 + 0.4 / 1
    expect(factor).toBeCloseTo(0.4 / 5.2 + 0.2 / 3.1 + 0.4, 12);
    expect(seq[1]).toBeCloseTo((0.4 / 5.2) / factor, 12);
    // 每个速度点在成片里那一刻正好放到素材里它的位置，那一刻的倍速就是它的 y
    points.forEach((point, i) => {
      expect(curveSource(points, seq[i])).toBeCloseTo(point.x, 9);
      expect(curveSpeedAt(points, seq[i])).toBeCloseTo(point.y, 9);
    });
  });

  it("moves forward through the whole source for every preset", () => {
    for (const key of Object.keys(SPEED_CURVES)) {
      const points = speedPreset(key);
      let last = -1;
      for (const u of STEPS) {
        const at = curveSource(points, u);
        expect(at, key).toBeGreaterThanOrEqual(last);
        last = at;
      }
      expect(curveSource(points, 0)).toBe(0);
      expect(curveSource(points, 1)).toBe(1);
    }
  });

  it("slices a curve into pieces that play the same frames", () => {
    for (const key of ["montage", "hero", "bullet", "jump_cut"]) {
      const points = speedPreset(key);
      const { factor } = seqOf(points);
      for (const cut of [0.2, 0.5, 0.77]) {
        const at = curveSource(points, cut);
        const head = sliceSpeedCurve(points, 0, cut);
        const tail = sliceSpeedCurve(points, cut, 1);
        // 两半在成片里的长度加起来等于原来的
        expect(seqOf(head).factor * at).toBeCloseTo(cut * factor, 9);
        expect(seqOf(tail).factor * (1 - at)).toBeCloseTo((1 - cut) * factor, 9);
        for (const u of STEPS) {
          expect(at * curveSource(head, u)).toBeCloseTo(curveSource(points, u * cut), 9);
          expect(at + (1 - at) * curveSource(tail, u)).toBeCloseTo(curveSource(points, cut + u * (1 - cut)), 9);
        }
      }
    }
  });
});

describe("the board's copy", () => {
  it("has the same presets and maths as the server", () => {
    expect(board.KEYFRAME_CURVES).toEqual(KEYFRAME_CURVES);
    expect(board.SPEED_CURVES).toEqual(SPEED_CURVES);
    const curve = [0.2, 1.3, 0.6, 0.9];
    const points = [{ x: 0, y: 3 }, { x: 0.3, y: 0.4 }, { x: 0.7, y: 6 }, { x: 1, y: 1 }];
    for (const u of STEPS) {
      expect(board.easeAt(curve, u)).toBeCloseTo(easeAt(curve, u), 12);
      expect(board.curveSource(points, u)).toBeCloseTo(curveSource(points, u), 12);
      expect(board.curveSpeedAt(points, u)).toBeCloseTo(curveSpeedAt(points, u), 12);
    }
    expect(board.seqOf(points).factor).toBeCloseTo(seqOf(points).factor, 12);
  });
});
