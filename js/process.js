// 录音处理：静音裁剪 → 淡入淡出 → 音量归一化 → WAV 编码 → 波形数据。
// 纯函数，不依赖 DOM，可以在 Node 里测试（tests/process.test.mjs）。

// —— 可调参数（经验值；真机试用后如果句首被吃掉或空白太长，就改这里）——
export const FRAME_MS = 5;             // 分析帧长。用 5ms 而不是 10ms：15ms 的按键声最多横跨 4 帧，凑不满 30ms
export const FLOOR_PERCENTILE = 0.2;   // 底噪 = 所有帧音量的第 20 百分位
export const FLOOR_MARGIN_DB = 12;     // 判定阈值 = 底噪 + 12 dB
export const MIN_THRESHOLD_DB = -50;   // 判定阈值不低于 -50 dBFS
export const LOUD_FLOOR_DB = -40;      // 底噪高于此值说明整段都是声音（从头说到尾/环境很吵）：不裁剪，整段保留
export const MIN_RUN_MS = 30;          // 连续超过阈值至少 30ms 才算人声
export const MIN_VOICE_MS = 200;       // 人声范围不足 200ms 判为「太短」
export const PAD_START_MS = 40;        // 人声起点前保留
export const PAD_END_MS = 120;         // 人声终点后保留（句尾自然衰减）
export const FADE_IN_MS = 8;
export const FADE_OUT_MS = 25;
export const TARGET_RMS_DB = -18;      // 人声帧 RMS 的目标音量
export const MAX_GAIN_DB = 20;
export const MIN_GAIN_DB = -12;
export const PEAK_CEILING_DB = -1;     // 归一化后峰值上限
export const PEAK_BARS = 48;           // 静态波形的竖条数

const SILENCE_DB = -120;

export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

export function gainToDb(gain) {
  return gain > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(gain)) : SILENCE_DB;
}

const msToSamples = (ms, sampleRate) => Math.round((ms / 1000) * sampleRate);

/** 每帧的 RMS 音量（dBFS）。 */
export function frameLevels(samples, frameLen) {
  const count = Math.ceil(samples.length / frameLen);
  const levels = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    const a = f * frameLen;
    const b = Math.min(samples.length, a + frameLen);
    let sum = 0;
    for (let i = a; i < b; i++) sum += samples[i] * samples[i];
    levels[f] = gainToDb(Math.sqrt(sum / (b - a)));
  }
  return levels;
}

/**
 * 找出人声范围。first/last 是帧下标（找不到时为 -1），start/end 是采样下标（end 不含）。
 */
export function detectVoice(samples, sampleRate) {
  const frameLen = Math.max(1, msToSamples(FRAME_MS, sampleRate));
  const levels = frameLevels(samples, frameLen);
  const empty = { first: -1, last: -1, start: 0, end: 0, frameLen, levels, threshold: 0 };
  if (levels.length === 0) return empty;

  const sorted = Float64Array.from(levels).sort();
  const floor = sorted[Math.floor((sorted.length - 1) * FLOOR_PERCENTILE)];
  const threshold = Math.max(floor + FLOOR_MARGIN_DB, MIN_THRESHOLD_DB);
  const minRun = Math.ceil(MIN_RUN_MS / FRAME_MS);

  let first = -1;
  let last = -1;
  let run = 0;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] > threshold) {
      run++;
      if (run >= minRun) {
        if (first < 0) first = i - run + 1;
        last = i;
      }
    } else {
      run = 0;
    }
  }
  if (first < 0 && floor > LOUD_FLOOR_DB) {
    // 最安静的 20% 帧都很响，阈值会被抬到人声之上；此时把整段当作人声
    return {
      first: 0,
      last: levels.length - 1,
      start: 0,
      end: samples.length,
      frameLen,
      levels,
      threshold: SILENCE_DB,
    };
  }
  if (first < 0) return { ...empty, threshold };
  return {
    first,
    last,
    start: first * frameLen,
    end: Math.min(samples.length, (last + 1) * frameLen),
    frameLen,
    levels,
    threshold,
  };
}

/** 原地做线性淡入淡出。 */
export function applyFades(samples, sampleRate) {
  const fadeIn = Math.min(samples.length, msToSamples(FADE_IN_MS, sampleRate));
  const fadeOut = Math.min(samples.length, msToSamples(FADE_OUT_MS, sampleRate));
  for (let i = 0; i < fadeIn; i++) samples[i] *= i / fadeIn;
  for (let i = 0; i < fadeOut; i++) samples[samples.length - 1 - i] *= i / fadeOut;
}

export function maxAbs(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

/** 把音频平均分成 n 段，取每段峰值并归一化到 0..1。 */
export function computePeaks(samples, n = PEAK_BARS) {
  const peaks = new Array(n).fill(0);
  if (samples.length === 0) return peaks;
  let top = 0;
  for (let k = 0; k < n; k++) {
    const a = Math.floor((k * samples.length) / n);
    const b = Math.max(a + 1, Math.floor(((k + 1) * samples.length) / n));
    let p = 0;
    for (let i = a; i < b && i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > p) p = v;
    }
    peaks[k] = p;
    if (p > top) top = p;
  }
  return top > 0 ? peaks.map((p) => Math.round((p / top) * 1000) / 1000) : peaks;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** 16-bit PCM 单声道 WAV。 */
export function encodeWav(samples, sampleRate) {
  const dataLen = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);            // fmt 块长度
  view.setUint16(20, 1, true);             // PCM
  view.setUint16(22, 1, true);             // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 每秒字节数
  view.setUint16(32, 2, true);             // 每帧字节数
  view.setUint16(34, 16, true);            // 采样位数
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataLen, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/** 解析 encodeWav 生成的 WAV（多声道时只取第一个声道），返回 Float32 采样。 */
export function decodeWav(buffer) {
  const view = new DataView(buffer);
  const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (buffer.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('不是 WAV 文件');

  let fmt = null;
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new Error('只支持 16-bit PCM');
      const stride = fmt.channels * 2;
      const length = Math.floor(Math.min(size, buffer.byteLength - body) / stride);
      const samples = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        const v = view.getInt16(body + i * stride, true);
        samples[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
      }
      return { sampleRate: fmt.sampleRate, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV 缺少 data 块');
}

/**
 * 完整处理一段录音。
 * 成功：{ wav, durationMs, peaks, samples, sampleRate }；失败：{ error: 'silent' | 'short' }。
 */
export function processRecording(input, sampleRate) {
  const voice = detectVoice(input, sampleRate);
  if (voice.first < 0) return { error: 'silent' };
  if (((voice.end - voice.start) / sampleRate) * 1000 < MIN_VOICE_MS) return { error: 'short' };

  const a = Math.max(0, voice.start - msToSamples(PAD_START_MS, sampleRate));
  const b = Math.min(input.length, voice.end + msToSamples(PAD_END_MS, sampleRate));
  const out = input.slice(a, b);

  // 人声帧（人声范围内超过阈值的帧）的 RMS，用原始数据计算
  let sum = 0;
  let count = 0;
  for (let f = voice.first; f <= voice.last; f++) {
    if (voice.levels[f] <= voice.threshold) continue;
    const fa = f * voice.frameLen;
    const fb = Math.min(input.length, fa + voice.frameLen);
    for (let i = fa; i < fb; i++) sum += input[i] * input[i];
    count += fb - fa;
  }
  const voicedDb = gainToDb(Math.sqrt(sum / count));

  applyFades(out, sampleRate);

  const gainDb = Math.min(MAX_GAIN_DB, Math.max(MIN_GAIN_DB, TARGET_RMS_DB - voicedDb));
  let gain = dbToGain(gainDb);
  const peak = maxAbs(out);
  const ceiling = dbToGain(PEAK_CEILING_DB);
  if (peak * gain > ceiling) gain = ceiling / peak;
  for (let i = 0; i < out.length; i++) out[i] *= gain;

  return {
    wav: encodeWav(out, sampleRate),
    durationMs: Math.round((out.length / sampleRate) * 1000),
    peaks: computePeaks(out, PEAK_BARS),
    samples: out,
    sampleRate,
  };
}
