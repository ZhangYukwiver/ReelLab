import { describe, expect, it } from "vitest";

import { MASTER_SOURCE, duckUnder, integratedLoudness, normalizeLoudness, truePeak } from "./master.mjs";

const RATE = 48_000;
const db = (value) => 20 * Math.log10(value);
/** 两个声道一样的正弦：seconds 秒、amp 振幅、hz 频率，phase 起始相位；from–to 秒以外是静音。 */
const tone = (seconds, amp, hz = 1000, { phase = 0, from = 0, to = seconds } = {}) => {
  const data = new Float32Array(Math.round(seconds * RATE));
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i += 1) data[i] = amp * Math.sin((2 * Math.PI * hz * i) / RATE + phase);
  return [data, Float32Array.from(data)];
};
const rms = (data, from, to) => {
  let sum = 0;
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i += 1) sum += data[i] * data[i];
  return Math.sqrt(sum / (Math.round(to * RATE) - Math.round(from * RATE)));
};

describe("mastering", () => {
  it("measures integrated loudness per BS.1770 and gates out silence", () => {
    // 两声道 1 kHz、-20 dBFS 的正弦是 -20 LUFS（单声道 0 dBFS 是 -3.01）
    expect(integratedLoudness(tone(10, 0.1))).toBeCloseTo(-20, 1);
    // 一半静音：门限把静音去掉，响度不变
    expect(Math.abs(integratedLoudness(tone(20, 0.1, 1000, { to: 10 })) + 20)).toBeLessThan(0.1);
    expect(integratedLoudness(tone(10, 0))).toBe(-Infinity);
  });

  it("finds the true peak between samples", () => {
    // 12 kHz 起始相位 45°：采样点只到振幅的 0.707，真峰值是振幅本身
    const channels = tone(1, 0.5, 12_000, { phase: Math.PI / 4 });
    expect(Math.max(...channels[0].slice(0, 1000))).toBeLessThan(0.36);
    expect(Math.abs(db(truePeak(channels)) - db(0.5))).toBeLessThan(0.2);
  });

  it("brings a mix to the target loudness under the true-peak ceiling", () => {
    // 安静的底子加几下很冲的峰：要往上提 15 dB，峰值得靠限幅压住
    const channels = tone(12, 0.05, 440);
    for (const at of [2, 5, 9]) for (let i = 0; i < 200; i += 1) channels[0][at * RATE + i] = channels[1][at * RATE + i] = 0.9 * Math.sin(i / 3);
    const result = normalizeLoudness(channels, -15, -2);
    expect(result.before).toBeLessThan(-23);
    expect(Math.abs(integratedLoudness(channels) + 15)).toBeLessThan(0.5);
    expect(db(truePeak(channels))).toBeLessThanOrEqual(-2 + 0.05);
    expect(result.peak).toBeLessThanOrEqual(-2 + 0.05);
  });

  it("ducks music only while the narration is speaking", () => {
    const music = tone(8, 0.3, 220);
    const voice = tone(8, 0.2, 500, { from: 3, to: 5 });
    duckUnder(music, voice, { rate: RATE });
    const dry = 0.3 / Math.SQRT2;
    // 旁白之前一点没动；旁白说话中间压下去 10 dB 以上；说完 2 秒（release 500ms）回来了
    expect(db(rms(music[0], 1, 2.9) / dry)).toBeCloseTo(0, 2);
    expect(db(rms(music[0], 3.5, 4.9) / dry)).toBeLessThan(-10);
    expect(db(rms(music[1], 3.5, 4.9) / dry)).toBeLessThan(-10);
    expect(db(rms(music[0], 7.5, 8) / dry)).toBeGreaterThan(-0.5);
  });

  it("ships source the encoder page can run on its own", () => {
    const run = new Function(`${MASTER_SOURCE}; return { integratedLoudness, normalizeLoudness, duckUnder };`)();
    expect(run.integratedLoudness(tone(5, 0.1))).toBeCloseTo(-20, 1);
  });
});
