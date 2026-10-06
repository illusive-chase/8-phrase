// 运行：node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  processRecording,
  detectVoice,
  decodeWav,
  encodeWav,
  dbToGain,
  gainToDb,
  maxAbs,
  PAD_START_MS,
  PAD_END_MS,
  MAX_GAIN_DB,
  PEAK_CEILING_DB,
  PEAK_BARS,
} from '../js/process.js';

const SR = 48000;

// 可复现的伪随机数（mulberry32）
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 按片段拼出一段测试音频：{ ms, amp, freq?, noise? } */
function build(parts, { noiseDb = null, seed = 1 } = {}) {
  const total = parts.reduce((n, p) => n + Math.round((p.ms / 1000) * SR), 0);
  const out = new Float32Array(total);
  const rand = rng(seed);
  let pos = 0;
  for (const p of parts) {
    const len = Math.round((p.ms / 1000) * SR);
    for (let i = 0; i < len; i++) {
      if (p.noise) out[pos + i] = (rand() * 2 - 1) * p.amp;
      else if (p.amp) out[pos + i] = p.amp * Math.sin((2 * Math.PI * (p.freq ?? 440) * i) / SR);
    }
    pos += len;
  }
  if (noiseDb !== null) {
    // 均匀白噪声的 RMS = 幅度 / √3
    const amp = dbToGain(noiseDb) * Math.sqrt(3);
    for (let i = 0; i < out.length; i++) out[i] += (rand() * 2 - 1) * amp;
  }
  return out;
}

function rmsDb(samples) {
  let s = 0;
  for (const v of samples) s += v * v;
  return gainToDb(Math.sqrt(s / samples.length));
}

test('P1 裁掉首尾静音', () => {
  const input = build([{ ms: 500 }, { ms: 800, amp: 0.3 }, { ms: 600 }], { noiseDb: -65 });
  const r = processRecording(input, SR);
  assert.ok(!r.error, `不应报错：${r.error}`);
  const expected = 800 + PAD_START_MS + PAD_END_MS;
  assert.ok(Math.abs(r.durationMs - expected) <= 30, `时长 ${r.durationMs}ms，期望 ${expected}±30ms`);
});

test('P2 全是底噪 → silent', () => {
  const input = build([{ ms: 1500 }], { noiseDb: -60 });
  assert.deepEqual(processRecording(input, SR), { error: 'silent' });
});

test('P2b 完全无声 → silent', () => {
  assert.deepEqual(processRecording(new Float32Array(SR), SR), { error: 'silent' });
});

test('P3 只有 100ms 的声音 → short', () => {
  const input = build([{ ms: 500 }, { ms: 100, amp: 0.3 }, { ms: 500 }], { noiseDb: -65 });
  assert.deepEqual(processRecording(input, SR), { error: 'short' });
});

test('P4 15ms 尖峰不会被当作人声起点', () => {
  // 尖峰在 200ms 处，人声从 600ms 开始；尖峰起点故意不对齐帧边界
  const spikeAt = 200.7;
  const input = build(
    [{ ms: spikeAt }, { ms: 15, amp: 0.9, noise: true }, { ms: 600 - spikeAt - 15 }, { ms: 700, amp: 0.25 }, { ms: 400 }],
    { noiseDb: -62, seed: 7 },
  );
  const v = detectVoice(input, SR);
  const startMs = (v.start / SR) * 1000;
  assert.ok(startMs >= 590, `人声起点 ${startMs.toFixed(1)}ms，不应早于真正的人声（600ms）`);
  const r = processRecording(input, SR);
  assert.ok(!r.error);
  const expected = 700 + PAD_START_MS + PAD_END_MS;
  assert.ok(Math.abs(r.durationMs - expected) <= 30, `时长 ${r.durationMs}ms，期望 ${expected}±30ms`);
});

test('P4b 不同对齐位置的 15ms 尖峰都不会触发', () => {
  for (let k = 0; k < 10; k++) {
    const at = 300 + k * 0.53;
    const input = build([{ ms: at }, { ms: 15, amp: 1, noise: true }, { ms: 1000 - at - 15 }], { noiseDb: -62, seed: k + 11 });
    assert.deepEqual(processRecording(input, SR), { error: 'silent' }, `尖峰位于 ${at}ms`);
  }
});

test('P5 小声最多放大 +20 dB', () => {
  // 正弦波 RMS = 幅度 / √2；让人声 RMS = -40 dBFS
  const amp = dbToGain(-40) * Math.SQRT2;
  const input = build([{ ms: 400 }, { ms: 800, amp }, { ms: 400 }], { noiseDb: -75 });
  const r = processRecording(input, SR);
  assert.ok(!r.error);
  const mid = r.samples.subarray(Math.round(0.2 * SR), Math.round(0.6 * SR));
  const outDb = rmsDb(mid);
  assert.ok(Math.abs(outDb - (-40 + MAX_GAIN_DB)) < 0.6, `输出 ${outDb.toFixed(2)} dBFS，期望约 ${-40 + MAX_GAIN_DB}`);
});

test('P5b 接近满幅的大声不会削波', () => {
  const input = build([{ ms: 300 }, { ms: 800, amp: 0.999 }, { ms: 300 }], { noiseDb: -65 });
  const r = processRecording(input, SR);
  assert.ok(!r.error);
  assert.ok(maxAbs(r.samples) <= dbToGain(PEAK_CEILING_DB) + 1e-6, `峰值 ${gainToDb(maxAbs(r.samples)).toFixed(2)} dBFS`);
  const decoded = decodeWav(r.wav).samples;
  assert.ok(maxAbs(decoded) <= dbToGain(PEAK_CEILING_DB) + 1e-4);
});

test('P5c 正常音量归一化到约 -18 dBFS', () => {
  const amp = dbToGain(-24) * Math.SQRT2;
  const input = build([{ ms: 300 }, { ms: 800, amp }, { ms: 300 }], { noiseDb: -70 });
  const r = processRecording(input, SR);
  const mid = r.samples.subarray(Math.round(0.2 * SR), Math.round(0.6 * SR));
  assert.ok(Math.abs(rmsDb(mid) + 18) < 0.6, `输出 ${rmsDb(mid).toFixed(2)} dBFS`);
});

test('P6 WAV 文件头正确', () => {
  const input = build([{ ms: 300 }, { ms: 500, amp: 0.3 }, { ms: 300 }], { noiseDb: -65 });
  const r = processRecording(input, SR);
  const v = new DataView(r.wav);
  const tag = (o) => String.fromCharCode(...new Uint8Array(r.wav, o, 4));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(12), 'fmt ');
  assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1, 'PCM');
  assert.equal(v.getUint16(22, true), 1, '单声道');
  assert.equal(v.getUint32(24, true), SR);
  assert.equal(v.getUint32(28, true), SR * 2);
  assert.equal(v.getUint16(32, true), 2);
  assert.equal(v.getUint16(34, true), 16, '16-bit');
  assert.equal(tag(36), 'data');
  const dataLen = v.getUint32(40, true);
  assert.equal(dataLen, r.samples.length * 2);
  assert.equal(v.getUint32(4, true), 36 + dataLen);
  assert.equal(r.wav.byteLength, 44 + dataLen);
  assert.equal(r.durationMs, Math.round((r.samples.length / SR) * 1000));
});

test('P6b WAV 编码后再解码，数据一致', () => {
  const input = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 0.8);
  const { sampleRate, samples } = decodeWav(encodeWav(input, 44100));
  assert.equal(sampleRate, 44100);
  assert.equal(samples.length, input.length);
  for (let i = 0; i < input.length; i++) assert.ok(Math.abs(samples[i] - input[i]) < 1e-4);
});

test('P7 波形数据为 48 个 0..1 的数', () => {
  const input = build([{ ms: 300 }, { ms: 600, amp: 0.3 }, { ms: 300, amp: 0.1, freq: 220 }, { ms: 300 }], { noiseDb: -65 });
  const r = processRecording(input, SR);
  assert.equal(r.peaks.length, PEAK_BARS);
  assert.equal(PEAK_BARS, 48);
  for (const p of r.peaks) assert.ok(p >= 0 && p <= 1, `peak ${p}`);
  assert.equal(Math.max(...r.peaks), 1);
});

test('首尾淡入淡出：第一个和最后一个采样为 0', () => {
  const input = build([{ ms: 100, amp: 0.5 }, { ms: 500, amp: 0.5 }], { noiseDb: -65 });
  const r = processRecording(input, SR);
  assert.ok(!r.error);
  assert.equal(r.samples[0], 0);
  assert.ok(Math.abs(r.samples[r.samples.length - 1]) < 1e-6);
});

test('从头到尾都有声音（没有静音段）时整段保留', () => {
  const input = build([{ ms: 1200, amp: 0.2 }], { noiseDb: -60 });
  const r = processRecording(input, SR);
  assert.ok(!r.error);
  assert.equal(r.durationMs, 1200);
});
