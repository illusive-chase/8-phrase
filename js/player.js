// 播放引擎：AudioContext 单例 + 预先准备好的 AudioBuffer，点击即播；同一时刻只播一句。

import { decodeWav } from './process.js';

let ctx = null;
let output = null;
const buffers = new Map(); // slot → AudioBuffer
let current = null; // { source, slot, startTime, duration, counted }
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn(current ? { slot: current.slot } : null);
}

/** 订阅播放状态变化（开始 / 结束 / 被打断）。 */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 获取（必要时创建）AudioContext，并尝试恢复。
 * 必须在用户操作的事件里第一次调用（iOS 要求）。
 */
export function ensureContext() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    output = ctx.createGain();
    output.connect(ctx.destination);
    // 老版本 iOS 需要在用户操作里真正播放一点声音才算解锁
    const blank = ctx.createBufferSource();
    blank.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    blank.connect(ctx.destination);
    blank.start();
  }
  if (ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
  return ctx;
}

/** 在任何用户操作里调用：解锁 / 恢复 AudioContext（iOS 被打断或切后台后会变成 suspended / interrupted）。 */
export function unlock() {
  ensureContext();
}

function toAudioBuffer(samples, sampleRate) {
  const buffer = new AudioBuffer({ numberOfChannels: 1, length: Math.max(1, samples.length), sampleRate });
  buffer.copyToChannel(samples, 0);
  return buffer;
}

/** 用处理好的采样直接生成 AudioBuffer（刚录完时用，免去再解码）。 */
export function setSamples(slot, samples, sampleRate) {
  buffers.set(slot, toAudioBuffer(samples, sampleRate));
}

/** 用数据库里的 WAV 字节准备 AudioBuffer；传 null 表示删除。 */
export function setWav(slot, wav) {
  if (!wav) {
    buffers.delete(slot);
    return;
  }
  try {
    const { samples, sampleRate } = decodeWav(wav);
    buffers.set(slot, toAudioBuffer(samples, sampleRate));
  } catch (err) {
    console.warn(`第 ${slot} 句录音解码失败`, err);
    buffers.delete(slot);
  }
}

export function clearAll() {
  stop();
  buffers.clear();
}

export function has(slot) {
  return buffers.has(slot);
}

/** 从头播放某一句；会先停掉正在播放的那句。返回是否真的开始播放。 */
export function play(slot) {
  const buffer = buffers.get(slot);
  if (!buffer) return false;
  ensureContext();
  stopSource();

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(output);
  const entry = { source, slot, startTime: ctx.currentTime, duration: buffer.duration };
  source.onended = () => {
    // 被手动 stop() 掉的旧音源也会触发 onended，只处理当前这一个
    if (current !== entry) return;
    current = null;
    emit();
  };
  source.start();
  current = entry;
  emit();
  return true;
}

function stopSource() {
  if (!current) return false;
  const { source } = current;
  current = null;
  try {
    source.stop();
  } catch {
    // 还没开始或已经结束
  }
  source.disconnect();
  return true;
}

export function stop() {
  if (stopSource()) emit();
}

/** 当前播放进度：{ slot, progress: 0..1 } 或 null。 */
export function progress() {
  if (!current || !ctx) return null;
  const p = (ctx.currentTime - current.startTime) / current.duration;
  return { slot: current.slot, progress: Math.min(1, Math.max(0, p)) };
}

/**
 * Safari 的 Audio Session API：'playback' 让 iPhone 打开静音开关时仍能出声，
 * 录音面板打开期间用 'play-and-record'。不支持的浏览器直接跳过。
 */
export function setSessionType(type) {
  try {
    if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type;
  } catch {
    // 忽略
  }
}
