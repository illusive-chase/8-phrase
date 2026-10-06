// 入口：状态、渲染、事件、模式切换。

import * as db from './db.js';
import * as player from './player.js';
import * as recorder from './recorder.js';
import * as wakelock from './wakelock.js';
import { processRecording } from './process.js';
import { watch as watchFit } from './fit-text.js';

const SETTINGS_KEY = '8p.settings';
const CONFIRM_MS = 3000;
const UNDO_MS = 4000;
const TEXT_SAVE_MS = 300;
const PLAYS_SAVE_MS = 400;

const $ = (id) => document.getElementById(id);

// —— 状态 ——
const state = {
  slots: [],
  mode: 'play', // 'play' | 'edit'
  sheet: null, // null | { type: 'record', slot } | { type: 'stats' } | { type: 'clear' } | { type: 'help' }
  rec: 'need-permission',
  settings: { wakeLock: true, installHintDismissed: false },
};

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const slotOf = (n) => state.slots[n - 1];
const hasAudio = (s) => !!(s && s.audio && player.has(s.id));
const displayText = (s) => s.text.trim() || `第 ${s.id} 句`;
const seconds = (ms) => (ms / 1000).toFixed(1);
const vibrate = (ms) => {
  try {
    if (navigator.vibrate) navigator.vibrate(ms);
  } catch {
    // 忽略
  }
};

// —— 设置（localStorage） ——

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    Object.assign(state.settings, raw);
  } catch {
    // 用默认值
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    // 无痕模式等
  }
}

// —— 保存 ——

function saveFailed(err) {
  console.error(err);
  toast(db.isQuotaError(err) ? '保存失败：存储空间不足' : '保存失败，请重试');
}

const pendingWrites = new Map(); // slot → timer

/** 延迟写入某一句（文字输入、播放计数）。 */
function scheduleSave(n, delay, { quiet = false } = {}) {
  clearTimeout(pendingWrites.get(n));
  pendingWrites.set(
    n,
    setTimeout(() => {
      pendingWrites.delete(n);
      db.put(slotOf(n)).catch(quiet ? (err) => console.warn(err) : saveFailed);
    }, delay),
  );
}

/**
 * 立即改动某一句并写入数据库。先改内存再写入，这样同一句的其他延迟写入总是写最新的数据；
 * 写入失败时把这次改动的字段恢复原样。成功返回改动前的副本，失败返回 null。
 */
async function commit(n, patch) {
  const s = slotOf(n);
  const before = { ...s };
  Object.assign(s, patch);
  clearTimeout(pendingWrites.get(n));
  pendingWrites.delete(n);
  try {
    await db.put(s);
    return before;
  } catch (err) {
    for (const key of Object.keys(patch)) s[key] = before[key];
    saveFailed(err);
    return null;
  }
}

function flushSaves() {
  for (const [n, timer] of pendingWrites) {
    clearTimeout(timer);
    db.put(slotOf(n)).catch((err) => console.warn(err));
  }
  pendingWrites.clear();
}

// —— 提示条 ——

const toastEl = $('toast');
const toastText = $('toast-text');
const toastAction = $('toast-action');
let toastTimer = 0;
let toastOnAction = null;

function toast(text, { action = null, onAction = null, duration = 2000 } = {}) {
  clearTimeout(toastTimer);
  toastText.textContent = text;
  toastAction.hidden = !action;
  if (action) toastAction.textContent = action;
  toastOnAction = onAction;
  toastEl.classList.add('show');
  toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastEl.classList.remove('show');
  toastOnAction = null;
}

toastAction.addEventListener('click', () => {
  const fn = toastOnAction;
  hideToast();
  if (fn) fn();
});

// —— 卡片 ——

const app = $('app');
const grid = $('grid');
const cards = [];

function buildCards() {
  for (let n = 1; n <= db.SLOT_COUNT; n++) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'card';
    el.dataset.slot = n;
    el.innerHTML =
      '<span class="fill"></span>' +
      `<span class="num" aria-hidden="true">${n}</span>` +
      '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>' +
      '<span class="text" aria-hidden="true"><span class="label"></span></span>' +
      '<span class="status" aria-hidden="true"></span>';
    grid.appendChild(el);
    const box = el.querySelector('.text');
    const label = el.querySelector('.label');
    cards.push({
      el,
      fill: el.querySelector('.fill'),
      label,
      status: el.querySelector('.status'),
      refit: watchFit(el, box, label, el.querySelector('.num')),
      text: null,
    });
    el.addEventListener('pointerdown', (e) => {
      el.classList.add('pressed');
      onCardDown(n, e);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      el.addEventListener(type, () => el.classList.remove('pressed'));
    }
    el.addEventListener('click', (e) => onCardClick(n, e));
    el.addEventListener('animationend', () => el.classList.remove('shake'));
  }
}

function renderCard(n) {
  const s = slotOf(n);
  const c = cards[n - 1];
  const recorded = hasAudio(s);
  c.el.classList.toggle('empty', !recorded);
  const text = displayText(s);
  if (c.text !== text) {
    c.text = text;
    c.label.textContent = text;
    c.label.classList.toggle('placeholder', !s.text.trim());
    c.refit();
  }
  c.status.textContent = recorded ? `已录 · ${seconds(s.durationMs)}s` : '＋ 点击录音';
  const base = s.text.trim() ? `第 ${n} 句：${s.text.trim()}` : `第 ${n} 句`;
  c.el.setAttribute('aria-label', recorded ? `${base}，已录音 ${seconds(s.durationMs)} 秒` : `${base}，未录音`);
}

function renderCards() {
  for (let n = 1; n <= db.SLOT_COUNT; n++) renderCard(n);
}

function shake(n) {
  const el = cards[n - 1].el;
  el.classList.remove('shake');
  if (reducedMotion.matches) return;
  void el.offsetWidth; // 重新触发动画
  el.classList.add('shake');
}

// 播放模式：按下就播放（不等抬起）；编辑模式：点击打开录音面板
function onCardDown(n, e) {
  if (state.mode !== 'play' || state.sheet || !e.isPrimary) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  playSlot(n);
}

function onCardClick(n, e) {
  if (state.sheet) return;
  if (state.mode === 'edit') openRecord(n);
  else if (e.detail === 0) playSlot(n); // 键盘触发的 click（回车 / 空格）
}

function playSlot(n) {
  const s = slotOf(n);
  if (!hasAudio(s)) {
    shake(n);
    toast('这句还没录音');
    return;
  }
  playOrigin = 'grid';
  if (!player.play(n)) return;
  vibrate(8);
  s.plays += 1;
  scheduleSave(n, PLAYS_SAVE_MS, { quiet: true });
}

// —— 播放状态与进度 ——

let playOrigin = 'grid'; // 'grid' | 'preview'
let progressRaf = 0;
let playingCard = 0;
const previewFill = document.querySelector('#rec-preview .fill');

function resetPlayVisuals() {
  if (playingCard) {
    const c = cards[playingCard - 1];
    c.el.classList.remove('playing');
    c.fill.style.transform = '';
    playingCard = 0;
  }
  previewFill.style.transform = '';
}

function progressTick() {
  const p = player.progress();
  if (!p) {
    progressRaf = 0;
    return;
  }
  const el = playOrigin === 'preview' ? previewFill : cards[p.slot - 1].fill;
  el.style.transform = `scaleX(${p.progress})`;
  progressRaf = requestAnimationFrame(progressTick);
}

player.onChange((now) => {
  resetPlayVisuals();
  if (!now) return;
  if (playOrigin === 'grid') {
    playingCard = now.slot;
    cards[now.slot - 1].el.classList.add('playing');
  }
  if (!progressRaf) progressRaf = requestAnimationFrame(progressTick);
});

// —— 模式与顶栏 ——

const wakeBtn = $('btn-wake');

function setMode(mode) {
  player.stop();
  state.mode = mode;
  app.dataset.mode = mode;
  updateWake();
  updateInstallHint();
  // 编辑模式下文字区底部要让出状态小字；提示条出现时网格也会变矮（这种情况 ResizeObserver 也会处理）
  for (const c of cards) c.refit();
}

function updateWake() {
  wakeBtn.hidden = !wakelock.supported;
  wakeBtn.setAttribute('aria-pressed', String(state.settings.wakeLock));
  wakelock.setWanted(state.mode === 'play' && state.settings.wakeLock);
}

wakeBtn.addEventListener('click', () => {
  state.settings.wakeLock = !state.settings.wakeLock;
  saveSettings();
  updateWake();
  toast(state.settings.wakeLock ? '屏幕常亮：开' : '屏幕常亮：关');
});

$('btn-edit').addEventListener('click', () => setMode('edit'));
$('btn-done').addEventListener('click', () => setMode('play'));
$('btn-stats').addEventListener('click', () => openSheet({ type: 'stats' }));
$('btn-clear').addEventListener('click', () => openSheet({ type: 'clear' }));

// —— 安装提示条 ——

const hint = $('install-hint');
let installEvent = null;

function updateInstallHint() {
  const iosHint = isIOS && !isStandalone();
  const androidHint = !isIOS && !!installEvent && !isStandalone();
  $('hint-ios').hidden = !iosHint;
  $('hint-android').hidden = !androidHint;
  hint.hidden = state.mode !== 'edit' || state.settings.installHintDismissed || !(iosHint || androidHint);
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  updateInstallHint();
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  updateInstallHint();
});
$('hint-install').addEventListener('click', async () => {
  const e = installEvent;
  if (!e) return;
  installEvent = null;
  try {
    await e.prompt();
  } catch {
    // 忽略
  }
  updateInstallHint();
});
$('hint-why').addEventListener('click', () => openSheet({ type: 'help' }));
$('hint-close').addEventListener('click', () => {
  state.settings.installHintDismissed = true;
  saveSettings();
  updateInstallHint();
});

// —— 面板 ——

const scrim = $('scrim');
const sheets = {
  record: $('sheet-record'),
  stats: $('sheet-stats'),
  clear: $('sheet-clear'),
  help: $('sheet-help'),
};
let lastFocus = null;

function openSheet(sheet) {
  if (state.sheet) closeSheet({ restoreFocus: false });
  else lastFocus = document.activeElement;
  player.stop();
  state.sheet = sheet;
  const el = sheets[sheet.type];
  if (sheet.type === 'stats') renderStats();
  if (sheet.type === 'record') onRecordOpen(sheet.slot);
  scrim.classList.add('open');
  el.classList.add('open');
  // 不在触屏上自动聚焦（会弹出键盘）；只把焦点移到面板本身，方便读屏和键盘操作
  el.focus({ preventScroll: true });
}

function closeSheet({ restoreFocus = true } = {}) {
  if (!state.sheet) return;
  const type = state.sheet.type;
  if (type === 'record') onRecordClose();
  if (type === 'stats') resetStatsConfirm();
  player.stop();
  sheets[type].classList.remove('open');
  scrim.classList.remove('open');
  state.sheet = null;
  if (document.activeElement && sheets[type].contains(document.activeElement)) document.activeElement.blur();
  if (restoreFocus && lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

scrim.addEventListener('click', () => {
  // 正在按住录音时不响应遮罩
  if (!hold.active) closeSheet();
});
for (const el of document.querySelectorAll('[data-close]')) {
  el.addEventListener('click', () => closeSheet());
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.sheet && !hold.active) closeSheet();
});

// 面板内的焦点循环
for (const el of Object.values(sheets)) {
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...el.querySelectorAll('button, input')].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

// —— 二次确认按钮 ——

function confirmButton(btn, { idle, armed, onConfirm }) {
  let timer = 0;
  const reset = () => {
    clearTimeout(timer);
    timer = 0;
    btn.textContent = idle;
    btn.classList.remove('confirm');
  };
  btn.addEventListener('click', () => {
    if (timer) {
      reset();
      onConfirm();
      return;
    }
    btn.textContent = armed;
    btn.classList.add('confirm');
    timer = setTimeout(reset, CONFIRM_MS);
  });
  return reset;
}

// —— 录音面板 ——

const recSheet = sheets.record;
const recTitle = $('rec-title-text');
const recText = $('rec-text');
const recCount = $('rec-count');
const recWave = $('rec-wave');
const recBars = $('rec-bars');
const recTime = $('rec-time');
const recHold = $('rec-hold');
const recHoldWrap = $('rec-hold-wrap');
const recHint = $('rec-hint');
const recPreview = $('rec-preview');
const recPreviewText = $('rec-preview-text');
const recDelete = $('rec-delete');
const BAR_COUNT = 48;
const barEls = [];
for (let i = 0; i < BAR_COUNT; i++) barEls.push(recBars.appendChild(document.createElement('i')));

const HINTS = {
  'need-permission': '点一下，开启麦克风',
  requesting: '请在弹窗中允许麦克风…',
  denied: '麦克风被拒绝了。请在浏览器的网站设置里允许麦克风，然后点这里重试',
  ready: '按住说话',
  recording: '松手保存 · 上滑取消',
  'cancel-armed': '松开手指，取消录音',
  processing: '处理中…',
};

let undo = null; // { slot, prev }：最近一次覆盖前的旧数据，关闭面板后丢弃
let take = null; // { id, slot, epoch, startedAt, timer, clock, limit }
let liveLevels = [];
let openToken = 0;

const recSlot = () => (state.sheet && state.sheet.type === 'record' ? state.sheet.slot : 0);

function openRecord(n) {
  openSheet({ type: 'record', slot: n });
}

function setRec(status) {
  state.rec = status;
  recSheet.dataset.rec = status;
  recHint.textContent = HINTS[status];
  recHold.disabled = status === 'requesting' || status === 'processing';
  recHold.setAttribute('aria-label', status === 'ready' ? '按住说话' : HINTS[status]);
  const busy = status === 'recording' || status === 'cancel-armed' || status === 'processing';
  $('rec-prev').disabled = busy || recSlot() <= 1;
  $('rec-next').disabled = busy || recSlot() >= db.SLOT_COUNT;
}

function renderRecord() {
  const n = recSlot();
  if (!n) return;
  const s = slotOf(n);
  recSheet.dataset.slot = n;
  recTitle.textContent = `第 ${n} 句`;
  if (document.activeElement !== recText || recText.value !== s.text) recText.value = s.text;
  recCount.textContent = `${[...s.text].length}/30`;
  const recorded = hasAudio(s);
  recPreview.disabled = !recorded;
  recDelete.disabled = !recorded;
  recPreviewText.textContent = recorded ? `试听 · ${seconds(s.durationMs)}s` : '试听';
  if (!take) renderStaticWave(s);
  setRec(state.rec);
}

function renderStaticWave(s) {
  if (!hasAudio(s) || !s.peaks || !s.peaks.length) {
    recWave.dataset.view = 'empty';
    return;
  }
  recWave.dataset.view = 'static';
  for (let i = 0; i < BAR_COUNT; i++) {
    const p = s.peaks[Math.floor((i * s.peaks.length) / BAR_COUNT)] || 0;
    barEls[i].style.height = `${Math.max(8, Math.round(p * 100))}%`;
  }
}

function renderLiveWave() {
  recWave.dataset.view = 'live';
  const start = BAR_COUNT - liveLevels.length;
  for (let i = 0; i < BAR_COUNT; i++) {
    const v = i >= start ? liveLevels[i - start] : 0;
    barEls[i].style.height = `${Math.max(8, Math.round(v * 100))}%`;
  }
}

function onLevel(rms) {
  if (!take) return;
  // 把 RMS 映射到 0..1：-60 dBFS → 0，-12 dBFS → 1
  const db_ = rms > 0 ? 20 * Math.log10(rms) : -100;
  const v = Math.min(1, Math.max(0, (db_ + 60) / 48));
  liveLevels.push(v);
  if (liveLevels.length > BAR_COUNT) liveLevels.shift();
  renderLiveWave();
  recHoldWrap.style.setProperty('--lv', v.toFixed(2));
}

function formatClock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${Math.floor((ms % 1000) / 100)}`;
}

async function onRecordOpen(n) {
  const token = ++openToken;
  undo = null;
  resetDeleteConfirm();
  player.setSessionType('play-and-record');
  setRec(recorder.isOpen() ? 'ready' : 'need-permission');
  renderRecord();
  if (!recorder.isOpen() && (await recorder.hasPermission()) && token === openToken && recSlot()) {
    openMic();
  }
}

function onRecordClose() {
  openToken++;
  hold.abort('close');
  recorder.close();
  player.setSessionType('playback');
  undo = null;
  if (state.rec !== 'denied') setRec('need-permission');
  recText.blur();
}

function gotoSlot(n) {
  if (n < 1 || n > db.SLOT_COUNT || take || state.rec === 'processing') return;
  player.stop();
  resetDeleteConfirm();
  undo = null;
  state.sheet = { type: 'record', slot: n };
  renderRecord();
}

$('rec-prev').addEventListener('click', () => gotoSlot(recSlot() - 1));
$('rec-next').addEventListener('click', () => gotoSlot(recSlot() + 1));

// 文字输入：停止 300ms 后保存
recText.addEventListener('input', () => {
  const n = recSlot();
  if (!n) return;
  const s = slotOf(n);
  s.text = recText.value.slice(0, 30);
  recCount.textContent = `${[...s.text].length}/30`;
  renderCard(n);
  scheduleSave(n, TEXT_SAVE_MS);
});
recText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    recText.blur();
  }
});

async function openMic() {
  const token = openToken;
  setRec('requesting');
  try {
    await recorder.open(onLevel);
    if (token !== openToken || !recSlot()) {
      recorder.close();
      return;
    }
    setRec('ready');
  } catch (err) {
    if (token !== openToken) return;
    console.warn(err);
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
      setRec('denied');
    } else {
      setRec('need-permission');
      toast(err && err.name === 'NotFoundError' ? '没有找到麦克风' : '麦克风打开失败，再试一次');
    }
  }
}

// 需要授权 / 被拒绝时，按钮是「点一下」
recHold.addEventListener('click', () => {
  player.unlock();
  if (state.rec === 'need-permission' || state.rec === 'denied') openMic();
});

const hold = recorder.bindHold(recHold, {
  canStart() {
    player.unlock();
    return state.rec === 'ready' && recorder.isOpen() && !!recSlot();
  },
  onStart() {
    const epoch = dataEpoch;
    player.stop();
    recText.blur();
    resetDeleteConfirm();
    vibrate(10);
    liveLevels = [];
    const startedAt = performance.now();
    take = {
      id: recorder.start(),
      slot: recSlot(),
      epoch,
      startedAt,
      timer: setTimeout(() => {
        if (take) take.limit = true;
        toast('最长 15 秒');
        hold.finish();
      }, recorder.MAX_RECORD_MS),
      clock: setInterval(() => {
        recTime.textContent = formatClock(performance.now() - startedAt);
      }, 100),
    };
    recTime.textContent = formatClock(0);
    renderLiveWave();
    setRec('recording');
  },
  onArm(armed) {
    if (take) setRec(armed ? 'cancel-armed' : 'recording');
  },
  async onRelease() {
    const t = endTake();
    if (!t) return;
    setRec('processing');
    const result = await recorder.stop(t.id, t.limit ? { tailMs: 0 } : undefined);
    if (!result) {
      // 麦克风在补录期间被关掉（关面板、来电等）
      afterTake();
      return;
    }
    let out;
    try {
      let samples = result.samples;
      if (t.limit) {
        // 到上限时只保留最后 15 秒（去掉开头的预录），保证整句不超过 15 秒
        const max = Math.round((recorder.MAX_RECORD_MS / 1000) * result.sampleRate);
        if (samples.length > max) samples = samples.subarray(samples.length - max);
      }
      out = processRecording(samples, result.sampleRate);
    } catch (err) {
      console.error(err);
      out = { error: 'failed' };
    }
    if (out.error) {
      toast(out.error === 'silent' ? '没听到声音，再试一次' : out.error === 'short' ? '太短了，按住久一点' : '处理失败，再试一次');
      afterTake();
      return;
    }
    await saveTake(t.slot, out, t.epoch);
    afterTake();
  },
  onCancel(reason) {
    const t = endTake();
    if (!t) return;
    recorder.cancel(t.id);
    if (reason === 'interrupt') toast('录音被打断，再试一次');
    afterTake();
  },
});

function endTake() {
  const t = take;
  if (!t) return null;
  clearTimeout(t.timer);
  clearInterval(t.clock);
  take = null;
  recHoldWrap.style.removeProperty('--lv');
  return t;
}

function afterTake() {
  if (!recSlot()) return;
  setRec(recorder.isOpen() ? 'ready' : 'need-permission');
  renderRecord();
}

let dataEpoch = 0; // 「清除全部」后加 1，丢弃清除前开始处理的录音

async function saveTake(n, out, epoch) {
  if (epoch !== dataEpoch) return;
  const firstEver = !state.slots.some((x) => x.audio);
  const prev = await commit(n, {
    audio: out.wav,
    durationMs: out.durationMs,
    peaks: out.peaks,
    plays: 0, // 重录只清零这一句（D7）
    recordedAt: Date.now(),
  });
  if (!prev) return;
  player.setSamples(n, out.samples, out.sampleRate);
  renderCard(n);
  if (recSlot() === n) {
    undo = { slot: n, prev };
    renderRecord();
    toast(`已保存第 ${n} 句`, { action: '撤销', onAction: () => undoTake(n), duration: UNDO_MS });
  } else {
    toast(`已保存第 ${n} 句`);
  }
  if (firstEver) requestPersist();
}

async function undoTake(n) {
  if (!undo || undo.slot !== n) return;
  const { prev } = undo;
  undo = null;
  const { audio, durationMs, peaks, plays, recordedAt } = prev;
  if (!(await commit(n, { audio, durationMs, peaks, plays, recordedAt }))) return;
  player.setWav(n, audio);
  renderCard(n);
  if (recSlot() === n) renderRecord();
  toast('已撤销');
}

function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch {
    // 忽略
  }
}

// 试听：同一个播放引擎，不计入播放次数
recPreview.addEventListener('pointerdown', () => player.unlock());
recPreview.addEventListener('click', () => {
  const n = recSlot();
  if (!n || !hasAudio(slotOf(n))) return;
  playOrigin = 'preview';
  player.play(n);
});

const resetDeleteConfirm = confirmButton(recDelete, {
  idle: '删除录音',
  armed: '再点一次确认删除',
  async onConfirm() {
    const n = recSlot();
    if (!n) return;
    player.stop();
    if (!(await commit(n, { audio: null, durationMs: 0, peaks: [], plays: 0, recordedAt: null }))) return;
    player.setWav(n, null);
    if (undo && undo.slot === n) undo = null;
    renderCard(n);
    renderRecord();
    toast(`已删除第 ${n} 句的录音`);
  },
});

// —— 播放统计 ——

const statsList = $('stats-list');
const statsSummary = $('stats-summary');

function renderStats() {
  const rows = [...state.slots].sort((a, b) => b.plays - a.plays || a.id - b.id);
  const total = rows.reduce((n, s) => n + s.plays, 0);
  const max = rows[0].plays;
  statsSummary.textContent = total ? `共播放 ${total} 次 · 最常说「${displayText(rows[0])}」` : '还没有播放记录，去玩吧';
  statsList.textContent = '';
  for (const s of rows) {
    const li = document.createElement('li');
    li.className = 'stats-row';
    li.dataset.slot = s.id;
    const isTop = total > 0 && s === rows[0];
    li.innerHTML =
      `<span class="num" aria-hidden="true">${s.id}</span>` +
      `<span class="name${s.text.trim() ? '' : ' placeholder'}"><span></span>${isTop ? '<em class="top">最多</em>' : ''}</span>` +
      `<span class="bar" aria-hidden="true"><i style="transform:scaleX(${max ? s.plays / max : 0})"></i></span>` +
      `<span class="n">${s.plays}</span>`;
    li.querySelector('.name span').textContent = displayText(s);
    li.setAttribute('aria-label', `第 ${s.id} 句 ${displayText(s)}：${s.plays} 次`);
    statsList.appendChild(li);
  }
}

const resetStatsConfirm = confirmButton($('stats-reset'), {
  idle: '重置统计',
  armed: '再点一次确认重置',
  async onConfirm() {
    const results = await Promise.all(state.slots.map((s) => commit(s.id, { plays: 0 })));
    renderStats();
    if (results.every(Boolean)) toast('统计已重置');
  },
});

// —— 清除全部 ——

$('clear-confirm').addEventListener('click', async () => {
  for (const [, timer] of pendingWrites) clearTimeout(timer);
  pendingWrites.clear();
  try {
    await db.clear();
  } catch (err) {
    saveFailed(err);
    return;
  }
  dataEpoch += 1;
  player.clearAll();
  state.slots = state.slots.map((s) => db.emptySlot(s.id));
  closeSheet({ restoreFocus: false });
  renderCards();
  setMode('edit');
  toast('已清除全部 8 句');
});

// —— 软键盘：iOS 弹出键盘时把页面往上推，这里把面板贴在键盘上方并让页面复位 ——

const vv = window.visualViewport;
function onViewport() {
  if (!vv) return;
  const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  const open = document.activeElement === recText && kb > 80;
  document.documentElement.style.setProperty('--kb', `${open ? kb : 0}px`);
  recSheet.classList.toggle('kb-open', open);
}
if (vv) {
  vv.addEventListener('resize', onViewport);
  vv.addEventListener('scroll', onViewport);
}
recText.addEventListener('focus', () => {
  // 只有键盘真的出现（视口变矮）才进入键盘布局；桌面端聚焦不影响
  setTimeout(onViewport, 50);
  setTimeout(onViewport, 350);
});
recText.addEventListener('blur', () => {
  document.documentElement.style.setProperty('--kb', '0px');
  recSheet.classList.remove('kb-open');
  window.scrollTo(0, 0);
});
// 任何原因导致的页面滚动都复位（保证永不滚动）
window.addEventListener('scroll', () => {
  if (window.scrollY !== 0 && document.activeElement !== recText) window.scrollTo(0, 0);
});

// iOS 会忽略 user-scalable=no，靠拦截手势事件阻止双指缩放
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
// 播放模式下禁止长按菜单和拖拽
document.addEventListener('contextmenu', (e) => {
  if (e.target !== recText) e.preventDefault();
});
document.addEventListener('dragstart', (e) => e.preventDefault());

// —— 生命周期 ——

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    player.stop();
    if (hold.active) hold.abort('interrupt');
    if (state.sheet && state.sheet.type === 'record') {
      recorder.close();
      if (state.rec !== 'denied') setRec('need-permission');
    }
    flushSaves();
  } else if (state.sheet && state.sheet.type === 'record' && !recorder.isOpen()) {
    // 回到前台：如果已授权就重新打开麦克风（下一次点击时 AudioContext 会被恢复）
    recorder.hasPermission().then((ok) => {
      if (ok && state.sheet && state.sheet.type === 'record' && !recorder.isOpen() && state.rec !== 'requesting') openMic();
    });
  }
});
window.addEventListener('pagehide', flushSaves);
// 任何点击都顺便恢复 AudioContext（iOS 被打断后是 interrupted 状态；部分 iOS 版本只认 touchend 里的解锁）
for (const type of ['pointerdown', 'pointerup', 'touchend']) {
  document.addEventListener(type, () => player.unlock(), { capture: true, passive: true });
}

// —— 启动 ——

function supported() {
  return (
    'indexedDB' in window &&
    'PointerEvent' in window &&
    typeof AudioContext !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined'
  );
}

function showUnsupported(text) {
  if (text) $('unsupported-text').textContent = text;
  $('unsupported').hidden = false;
}

async function boot() {
  if (!supported()) {
    showUnsupported();
    return;
  }
  loadSettings();
  buildCards();
  try {
    state.slots = await db.getAll();
  } catch (err) {
    console.error(err);
    showUnsupported('无法打开本地存储。如果正在使用无痕模式，请换成普通模式打开。');
    return;
  }
  for (const s of state.slots) if (s.audio) player.setWav(s.id, s.audio);
  renderCards();
  player.setSessionType('playback');
  setMode(state.slots.some((s) => hasAudio(s)) ? 'play' : 'edit');
}

boot();

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service Worker 注册失败', err));
  });
}
