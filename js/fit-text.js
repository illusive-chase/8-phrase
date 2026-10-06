// 卡片文字字号自适应：从 min(34px, 卡片高度 × 0.26) 开始逐 1px 缩小，直到文字不溢出；最小 13px，
// 到了最小值仍然放不下就按能放下的行数截断（最多 4 行）加省略号。
// 文字不能压住左上角的编号圆点，因此试两种排法，取字号大的那种：
//   A. 文字在整张卡片里居中，但不能碰到圆点
//   B. 文字区从圆点下方开始（卡片加 below-dot 类）

const MAX_PX = 34;
const MIN_PX = 13;
const HEIGHT_RATIO = 0.26;
const LINE_HEIGHT = 1.25;
const MAX_LINES = 4;
const DOT_GAP = 6;

function hitsDot(label, dot) {
  const d = dot.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(label);
  // 行盒的上下边界含行距；按字号收进一点，接近字形的实际范围
  const inset = (parseFloat(label.style.fontSize) * (LINE_HEIGHT - 1)) / 2;
  for (const r of range.getClientRects()) {
    const top = r.top + inset;
    const bottom = r.bottom - inset;
    if (r.right > d.left - DOT_GAP && r.left < d.right + DOT_GAP && bottom > d.top - DOT_GAP && top < d.bottom + DOT_GAP) return true;
  }
  return false;
}

/** 在当前排法下找最大可用字号。返回 { size, ok }；ok 表示这个字号下既不溢出也不碰圆点。 */
function search(card, box, label, dot, avoidDot) {
  const boxW = box.clientWidth;
  const boxH = box.clientHeight;
  const bad = () => label.scrollHeight > boxH + 0.5 || label.scrollWidth > boxW + 0.5 || (avoidDot && hitsDot(label, dot));
  let size = Math.max(MIN_PX, Math.floor(Math.min(MAX_PX, card.clientHeight * HEIGHT_RATIO)));
  label.style.fontSize = `${size}px`;
  while (size > MIN_PX && bad()) {
    size -= 1;
    label.style.fontSize = `${size}px`;
  }
  return { size, ok: boxW > 0 && boxH > 0 && !bad() };
}

/** 调整 label 的字号以放进 box（label 的容器）。card 用来取卡片高度，dot 是编号圆点。 */
export function fit(card, box, label, dot) {
  label.classList.remove('clamped');
  label.style.webkitLineClamp = '';
  if (card.clientHeight <= 0) return;

  card.classList.remove('below-dot');
  const a = search(card, box, label, dot, true);
  card.classList.add('below-dot');
  const b = search(card, box, label, dot, false);

  if (a.ok && a.size >= b.size) {
    card.classList.remove('below-dot');
    label.style.fontSize = `${a.size}px`;
    return;
  }
  label.style.fontSize = `${b.size}px`;
  if (!b.ok) {
    const lines = Math.max(1, Math.min(MAX_LINES, Math.floor(box.clientHeight / (b.size * LINE_HEIGHT))));
    label.style.webkitLineClamp = String(lines);
    label.classList.add('clamped');
  }
}

/** 给卡片挂 ResizeObserver，尺寸变化时自动重新计算。返回立即重算的函数。 */
export function watch(card, box, label, dot) {
  const refit = () => fit(card, box, label, dot);
  if ('ResizeObserver' in window) {
    let last = '';
    // 观察卡片而不是文字区：below-dot 会改变文字区尺寸，观察文字区会自己触发自己
    new ResizeObserver(() => {
      const mode = card.closest('[data-mode]')?.dataset.mode;
      const key = `${card.clientWidth}x${card.clientHeight}:${mode}`;
      if (key === last) return;
      last = key;
      refit();
    }).observe(card);
  }
  return refit;
}
