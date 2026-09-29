import { frameSvg, stillBootingText } from './boot-frames.js';

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
  const frame = (now) => {
    svg.innerHTML = frameSvg(t0 === null ? 0 : (now - t0) / 1000);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// 起動が長いときは文を替える。失敗の文（data-level="error"、殻が書く）が出たら、もう触らない。
const tick = setInterval(() => {
  if (status.dataset.level === 'error') { clearInterval(tick); return; }
  if (t0 === null) return;
  const text = stillBootingText(performance.now() - t0);
  if (text) status.textContent = text;
}, 1000);
