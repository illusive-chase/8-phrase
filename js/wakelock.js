// 屏幕常亮：条件满足时申请，不满足时释放；回到前台时自动重新申请。

let sentinel = null;
let wanted = false;
let pending = null;

export const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

async function acquire() {
  if (sentinel || pending || document.visibilityState !== 'visible') return;
  pending = navigator.wakeLock
    .request('screen')
    .then((s) => {
      sentinel = s;
      s.addEventListener('release', () => {
        if (sentinel === s) sentinel = null;
      });
      // 申请期间条件变了
      if (!wanted) release();
    })
    .catch(() => {
      // 省电模式、权限策略等都会拒绝；静默降级
    })
    .finally(() => {
      pending = null;
    });
  await pending;
}

function release() {
  const s = sentinel;
  sentinel = null;
  if (s) s.release().catch(() => {});
}

/** 设置是否需要屏幕常亮（播放模式 且 开关打开）。 */
export function setWanted(value) {
  if (!supported) return;
  wanted = value;
  if (wanted) acquire();
  else release();
}

if (supported) {
  document.addEventListener('visibilitychange', () => {
    // 切到后台时系统会自动释放；回来时如果仍然需要，就重新申请
    if (document.visibilityState === 'visible' && wanted) acquire();
  });
}
