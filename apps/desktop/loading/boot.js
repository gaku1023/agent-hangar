import { frameSvg, nearestBoundary, stillBootingText } from './boot-frames.js';

// 起動画面の描画。
// 動きの時計は頁の load から数える。殻（lib.rs の settle_delay）も同じ合図から周期を数え、周の境目まで待ってから画面を移す。
// reduced motion では、静止した原図（logo.svg）と文字だけを出す。
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const status = document.getElementById('status');
let t0 = null;
const begin = () => { t0 = performance.now(); };
if (document.readyState === 'complete') begin();
else addEventListener('load', begin, { once: true });

if (!still) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('width', '96');
  svg.setAttribute('height', '96');
  svg.setAttribute('aria-hidden', 'true');
  // 揺れる札は枠から少しはみ出すので、切らない。
  svg.style.overflow = 'visible';
  document.getElementById('logo').replaceWith(svg);
  let raf = 0;
  let stopped = false;
  // 流れを止め、いちばん近い周の境目の絵で静止させる。
  // 殻は周の境目まで待ってからこれを呼び、それから画面を移す（lib.rs の BOOT_SETTLE_JS）。
  // 止めないと、移る直前のコマで新しい札が薄く降り始める。
  const settle = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    svg.innerHTML = frameSvg(nearestBoundary(t0 === null ? 0 : performance.now() - t0));
  };
  const frame = (now) => {
    if (stopped) return;
    // 失敗の文が出たら、起動はもう進まない。流れ続けると、まだ待てば済むように見える。
    if (status.dataset.level === 'error') { settle(); return; }
    svg.innerHTML = frameSvg(t0 === null ? 0 : (now - t0) / 1000);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  window.__hangarBootSettle = settle;
}

// 起動が長いときは文を替える。失敗の文（data-level="error"、殻が書く）が出たら、もう触らない。
const tick = setInterval(() => {
  if (status.dataset.level === 'error') { clearInterval(tick); return; }
  if (t0 === null) return;
  const text = stillBootingText(performance.now() - t0);
  if (text) status.textContent = text;
}, 1000);
