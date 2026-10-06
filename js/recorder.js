// 录音：麦克风权限、麦克风流的开关、worklet 管理、按住说话的手势。

import { ensureContext } from './player.js';

const TAIL_MS = 250; // 松手后补录
export const MAX_RECORD_MS = 15000;
const CANCEL_UP_PX = 64; // 上移超过这个距离进入取消
const CANCEL_OUT_PX = 32; // 移出按钮外扩这个范围也进入取消

const WORKLET_URL = new URL('./recorder-worklet.js', import.meta.url);

let workletLoaded = null;
let stream = null;
let source = null;
let node = null;
let sink = null;
let grantedThisSession = false;
let takeId = 0;
const pending = new Map(); // id → resolve

/** 只用来决定是否直接打开麦克风：已授权返回 true；未知或未授权返回 false。 */
export async function hasPermission() {
  if (grantedThisSession) return true;
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state === 'granted';
  } catch {
    return false;
  }
}

export function isOpen() {
  return !!stream;
}

/**
 * 打开麦克风流（只在录音面板打开期间）。
 * onLevel(rms, peak) 每 50ms 调一次（只在录音中）。成功返回 true；用户拒绝抛出 NotAllowedError。
 */
let opening = null;

export function open(onLevel) {
  if (stream) return Promise.resolve(true);
  // 同时只发起一次 getUserMedia，避免重复打开的流泄漏
  if (!opening) opening = doOpen(onLevel).finally(() => (opening = null));
  return opening;
}

async function doOpen(onLevel) {
  const ctx = ensureContext();
  if (!workletLoaded) {
    workletLoaded = ctx.audioWorklet.addModule(WORKLET_URL).catch((err) => {
      workletLoaded = null;
      throw err;
    });
  }
  const media = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: true,
    },
  });
  grantedThisSession = true;
  try {
    await workletLoaded;
  } catch (err) {
    media.getTracks().forEach((t) => t.stop());
    throw err;
  }
  stream = media;
  source = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, 'recorder', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete', // 多声道设备只取第一个声道
  });
  // 输出接一个静音的 GainNode 再到扬声器，保证 worklet 一直被驱动，但不会出声
  sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);
  node.port.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'level') onLevel && onLevel(msg.rms, msg.peak);
    else if (msg.type === 'done') {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      if (resolve) resolve({ samples: msg.samples, sampleRate: msg.sampleRate });
    }
  };
  // 系统收回麦克风（例如来电）时，当作被打断
  for (const track of stream.getTracks()) {
    track.addEventListener('ended', () => {
      if (stream === media) close();
    });
  }
  return true;
}

/** 关闭麦克风流，让系统的麦克风指示灯熄灭。 */
export function close() {
  for (const [, resolve] of pending) resolve(null);
  pending.clear();
  if (node) {
    node.port.onmessage = null;
    node.disconnect();
  }
  if (source) source.disconnect();
  if (sink) sink.disconnect();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = source = node = sink = null;
}

/** 开始一段录音，返回 id。 */
export function start() {
  takeId += 1;
  node.port.postMessage({ type: 'start', id: takeId });
  return takeId;
}

/**
 * 结束录音，返回 { samples, sampleRate }；麦克风被关掉时返回 null。
 * 默认补录 250ms；到 15 秒上限自动结束时不补录（tailMs = 0）。
 */
export function stop(id, { tailMs = TAIL_MS } = {}) {
  if (!node) return Promise.resolve(null);
  return new Promise((resolve) => {
    pending.set(id, resolve);
    node.port.postMessage({ type: 'stop', id, tailMs });
  });
}

export function cancel(id) {
  if (node) node.port.postMessage({ type: 'cancel', id });
}

/**
 * 按住说话的手势。
 * handlers: canStart() → bool, onStart(), onArm(armed), onRelease(), onCancel(reason)
 * reason: 'slide'（上滑取消）| 'interrupt'（系统打断）
 * 返回 { abort(reason) }，用于外部打断（切后台、关面板）。
 */
export function bindHold(button, handlers) {
  let active = null; // { pointerId | 'key', x, y, armed }

  const inZone = (e) => {
    const r = button.getBoundingClientRect();
    return (
      e.clientX >= r.left - CANCEL_OUT_PX &&
      e.clientX <= r.right + CANCEL_OUT_PX &&
      e.clientY >= r.top - CANCEL_OUT_PX &&
      e.clientY <= r.bottom + CANCEL_OUT_PX
    );
  };

  const begin = (id, x, y) => {
    if (active || !handlers.canStart()) return false;
    active = { id, x, y, armed: false };
    handlers.onStart();
    return true;
  };

  const end = (cancelled, reason) => {
    if (!active) return;
    const wasArmed = active.armed;
    active = null;
    if (cancelled) handlers.onCancel(reason);
    else if (wasArmed) handlers.onCancel('slide');
    else handlers.onRelease();
  };

  button.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (!begin(e.pointerId, e.clientX, e.clientY)) return;
    e.preventDefault();
    try {
      button.setPointerCapture(e.pointerId);
    } catch {
      // 忽略
    }
  });

  button.addEventListener('pointermove', (e) => {
    if (!active || active.id !== e.pointerId) return;
    const armed = active.y - e.clientY > CANCEL_UP_PX || !inZone(e);
    if (armed !== active.armed) {
      active.armed = armed;
      handlers.onArm(armed);
    }
  });

  button.addEventListener('pointerup', (e) => {
    if (active && active.id === e.pointerId) end(false);
  });
  button.addEventListener('pointercancel', (e) => {
    if (active && active.id === e.pointerId) end(true, 'interrupt');
  });
  button.addEventListener('lostpointercapture', (e) => {
    // 某些浏览器在系统手势接管时只发 lostpointercapture
    if (active && active.id === e.pointerId) end(true, 'interrupt');
  });

  // 桌面端：按钮获得焦点后，按住空格等同于按住按钮
  button.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    e.preventDefault();
    begin('key', 0, 0);
  });
  button.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    e.preventDefault();
    if (active && active.id === 'key') end(false);
  });
  button.addEventListener('blur', () => {
    if (active && active.id === 'key') end(true, 'interrupt');
  });
  button.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    get active() {
      return !!active;
    },
    abort(reason = 'interrupt') {
      if (!active) return;
      active = null;
      handlers.onCancel(reason);
    },
    /** 时间到等外部原因结束：按松手保存处理，并忽略之后的 pointerup。 */
    finish() {
      if (!active) return;
      active = null;
      handlers.onRelease();
    },
  };
}
