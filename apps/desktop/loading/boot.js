import { BEAT_S, FINISH_MS, detailText, dots, finishOf, finishSvg, frameSvg, nearestBoundary, slowSuffix } from './boot-frames.js';
import { failView } from './boot-fail.js';

// 起動画面の描画。動きの時計は頁の load から数える。
// 合図の口（__hangarBootFinish）は、読み込みが終わった合図を打ち、UI の背景の光を画面いっぱいに満たす。
// 殻は準備ができたらすぐ呼ぶ。周の境目は待たず、合図が今の札の並びから受け止める（boot-frames.js の finishOf）。
// 殻はその長さ（FINISH_MS）だけ待ってから画面を移すので、移る直前の絵は UI の背景そのものになる。
// reduced motion では、静止した原図（logo.svg）と文字だけを出し、合図も文と溶かしだけにする。
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const status = document.getElementById('status');
const detail = document.getElementById('detail');
const main = document.querySelector('main');
const aura = document.getElementById('aura');
const fx = document.getElementById('fx');
let t0 = null;
const begin = () => { t0 = performance.now(); };
if (document.readyState === 'complete') begin();
else addEventListener('load', begin, { once: true });
const since = () => (t0 === null ? 0 : performance.now() - t0);

const clamp = (t) => Math.max(0, Math.min(1, t));
const eOut = (t) => 1 - Math.pow(1 - t, 3);
const eIn = (t) => t * t * t;
const BLUE = '#4a63e8';
/** ロゴの大きさ（px）。index.html の静止画と揃える（config.test.ts が突き合わせる）。 */
const LOGO = 128;

let svg = null;
let raf = 0;
let stopped = false;
if (!still) {
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('width', String(LOGO));
  svg.setAttribute('height', String(LOGO));
  svg.setAttribute('aria-hidden', 'true');
  // 揺れる札は枠から少しはみ出すので、切らない。弾むときは札の真ん中あたりを軸にする。
  svg.style.overflow = 'visible';
  svg.style.transformOrigin = '50% 60%';
  document.getElementById('logo').replaceWith(svg);
  const frame = (now) => {
    if (stopped) return;
    // 失敗の文が出たら、起動はもう進まない。流れ続けると、まだ待てば済むように見える。
    if (status.dataset.level === 'error') { settle(); return; }
    svg.innerHTML = frameSvg(t0 === null ? 0 : (now - t0) / 1000);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
}

// 流れを止める。
function stop() {
  if (stopped) return false;
  stopped = true;
  cancelAnimationFrame(raf);
  return true;
}

// 流れを止め、いちばん近い周の境目の絵で静止させる。止めないと、失敗の文の横で札が降り続ける。
function settle() {
  if (stop() && svg) svg.innerHTML = frameSvg(nearestBoundary(since()));
}

// 読み込みが終わった合図（K3）と、UI の背景の光が満ちる動き（F4）。値は boot-frames.js の finishOf が持つ。
let finishing = null;

function finish() {
  if (finishing || status.dataset.level === 'error') return;
  // 合図は今の時刻の絵から続ける。境目の絵へ跳ばない。
  const T = since() / 1000;
  stop();
  status.dataset.level = 'ready';
  status.textContent = 'ようこそ';
  detail.textContent = '';
  // 輪と光はロゴの真ん中から広げる。窓の大きさは 1400×900 を基準に、大きい窓ほど遠くまで届かせる。
  const box = (svg || document.getElementById('logo')).getBoundingClientRect();
  const S = box.width || LOGO;
  const cx = box.left + box.width / 2;
  const cy = box.top + S * 0.55;
  const k = Math.max(innerWidth / 1400, innerHeight / 900, 1);
  const start = performance.now();
  finishing = { T, raf: 0 };
  const draw = (now) => {
    const tb = Math.max(0, (now - start) / 1000);
    const f = finishOf(T, tb);
    if (!still) {
      svg.innerHTML = finishSvg(T, tb);
      svg.style.transform = `scale(${f.scale.toFixed(4)})`;
      fx.innerHTML = f.rings.map((r) => (r <= 0 || r >= 1 ? '' : `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(S * 0.45 + 900 * k * eOut(r)).toFixed(1)}" fill="none" stroke="${BLUE}" stroke-width="${(3 * (1 - r) + 0.5).toFixed(2)}" opacity="${(0.7 * (1 - r)).toFixed(3)}"/>`)).join('');
    }
    const done = tb * 1000 >= FINISH_MS;
    // F4：ロゴの奥から光が円く滲みながら満ち、ロゴと文字は少し浮きながら溶ける。
    // 満ち切った絵は縁の暈しを外し、UI の背景（.shell::before）と一致させる。
    const q = eOut(f.bloom);
    const mask = still || done ? '' : `radial-gradient(circle at ${cx.toFixed(0)}px ${cy.toFixed(0)}px, #000 ${((S * 0.5 + (1900 * k - S * 0.5) * q) * 0.55).toFixed(0)}px, transparent ${(S * 0.5 + (1900 * k - S * 0.5) * q).toFixed(0)}px)`;
    aura.style.webkitMaskImage = mask;
    aura.style.maskImage = mask;
    aura.style.opacity = String(done ? 1 : still ? Number(q.toFixed(3)) : Number(clamp(f.bloom / 0.3).toFixed(3)));
    main.style.opacity = String(done ? 0 : Number((1 - eIn(f.bloom)).toFixed(3)));
    if (!still) main.style.transform = `translateY(${(-16 * eIn(f.bloom)).toFixed(2)}px)`;
    if (!done) finishing.raf = requestAnimationFrame(draw);
  };
  draw(start);
  report();
}

// 合図の後に失敗の文が出たら（画面を移せなかったとき）、合図を取り消して文が読めるように戻す。
// ロゴは合図で締まった 4 枚の絵のまま止める。
new MutationObserver(() => {
  if (status.dataset.level !== 'error' || !finishing) return;
  cancelAnimationFrame(finishing.raf);
  for (const p of ['opacity', 'transform']) main.style[p] = '';
  aura.style.opacity = '0';
  aura.style.webkitMaskImage = '';
  aura.style.maskImage = '';
  fx.innerHTML = '';
  if (svg) { svg.style.transform = ''; svg.innerHTML = finishSvg(finishing.T, BEAT_S); }
}).observe(status, { attributes: true, attributeFilter: ['data-level'] });

window.__hangarBootFinish = finish;

// 待っている間の文。「読み込み中」の後ろの点を増やし、長いときは秒数を、境目を過ぎたら何をしているかを添える。
// 殻が渡すのは失敗（__hangarBootFail。data-level="error" の印が立つ）と、索引の進み具合（__hangarBootProgress）だけで、ほかの文はここで作る。
// 失敗や合図の文が出たら、もう触らない。
let progress = null;
window.__hangarBootProgress = (p) => { progress = p; };
const tick = setInterval(() => {
  if (status.dataset.level === 'error') { detail.textContent = ''; clearInterval(tick); return; }
  if (status.dataset.level === 'ready') { clearInterval(tick); return; }
  if (t0 === null) return;
  const ms = performance.now() - t0;
  // 点の数が変わっても語が左右に揺れないよう、点の置き場の幅を取り、左にも同じ幅の空きを置く。
  const html = `<span class="dots-pad"></span>読み込み中<span class="dots">${still ? '...' : dots(ms)}</span>${slowSuffix(ms)}`;
  if (status.dataset.html !== html) { status.innerHTML = html; status.dataset.html = html; }
  const d = detailText(progress, ms);
  if (detail.textContent !== d) detail.textContent = d;
}, 100);

// 起動に失敗したら、殻が種類と数を渡し、頁が 1 枚の札で出す（2.11.3）。
// 札の文は boot-fail.js の表から引く。殻の文字列は innerHTML に入れず、textContent だけで書く。
// 「もう一度試す」と「ログを開く」は殻の命令（lib.rs の retry_boot と open_log）で、この頁（tauri://localhost）からだけ呼べる（capabilities/boot-screen.json）。
// やり直すと殻がこの頁を読み込み直すので、ボタンは一度押したら押せなくしておく。殻が断ったら戻す。
const $ = (id) => document.getElementById(id);
const card = $('fail');
const brand = $('fail-brand');
const retry = $('boot-retry');
const openLog = $('boot-log');
const copyCommand = $('fail-command-copy');
const copyAll = $('fail-copy-all');
const invoke = (...a) => window.__TAURI_INTERNALS__?.invoke?.(...a);

// 試験のための書き出し（lib.rs の boot_probe）。殻が HANGAR_BOOT_PROBE を持って起きたときだけ、boot_state が probe を真で返す。
// そのときだけ、頁が描いた様子（札が出たか、印、種類、見出し、詳細）を DOM から読んで殻へ渡し、殻がファイルに書く。
// CI はそれを読んで、Node の無い機械で札に切り替わったことを確かめる。ふだんの起動では呼ばない。
let probing = false;
function report() {
  if (!probing) return;
  const drawn = {
    level: status.dataset.level ?? null,
    card: !card.hidden,
    kind: document.body.dataset.fail ?? null,
    lang: document.documentElement.lang,
    title: $('fail-title').textContent,
    detail: $('fail-detail').textContent,
  };
  Promise.resolve(invoke('boot_probe', { drawn })).catch(() => {});
}
// 今の札のコピーする文と、押した印を戻す文。
let view = null;
const restore = new Map();

// クリップボードの口が無い頁（権限が無い、口そのものが無い）でも写せるよう、選択して copy の命令を打つ。
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

async function copy(text, button, idle) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ok = legacyCopy(text);
  }
  if (!ok || !view) return;
  button.textContent = view.labels.copied;
  clearTimeout(restore.get(button));
  restore.set(button, setTimeout(() => { button.textContent = idle(); }, 1500));
}

window.__hangarBootFail = (info) => {
  view = failView(info);
  const v = view;
  document.documentElement.lang = v.lang;
  $('fail-title').textContent = v.title;
  $('fail-what').textContent = v.what;
  $('fail-next').textContent = v.labels.whatNext;
  $('fail-steps').replaceChildren(...v.steps.map((step) => Object.assign(document.createElement('li'), { textContent: step })));
  $('fail-command-box').hidden = v.command === null;
  $('fail-command').textContent = v.command ?? '';
  $('fail-details-label').textContent = v.labels.details;
  $('fail-log-at').textContent = v.labels.logAt;
  $('fail-detail').textContent = v.detail;
  $('fail-env').textContent = v.footer;
  copyCommand.textContent = v.labels.copyCommand;
  copyAll.textContent = v.labels.copyAll;
  openLog.textContent = v.labels.openLog;
  retry.textContent = v.labels.tryAgain;
  retry.disabled = false;
  // 待っている間の絵はもう進まない。印を立てると、流れと待ちの文が止まり、合図の途中だったなら元へ戻す（上の観察）。
  status.dataset.level = 'error';
  main.hidden = true;
  // 札を窓の中に収める余白（上はヘッダーの高さ）を効かせる。種類は印として残す。
  document.body.dataset.fail = v.kind;
  brand.hidden = false;
  card.hidden = false;
  // Enter で「もう一度試す」を押せるよう、焦点をここに置く。
  retry.focus({ preventScroll: true });
  report();
};

retry.addEventListener('click', () => {
  if (retry.disabled) return;
  retry.disabled = true;
  Promise.resolve(invoke('retry_boot')).catch(() => { retry.disabled = false; });
});
openLog.addEventListener('click', () => { Promise.resolve(invoke('open_log')).catch(() => {}); });
copyCommand.addEventListener('click', () => { if (view?.command) copy(view.command, copyCommand, () => view.labels.copyCommand); });
copyAll.addEventListener('click', () => { if (view) copy(view.copyText, copyAll, () => view.labels.copyAll); });

// 口を作り終えたので、殻に今の様子を問い合わせ、先に起きたことを引き取る（lib.rs の boot_state）。
// 殻の評価は、この頁の口が出来る前に届くと捨てられる。macOS では読み込みの合図の時点でもまだこの頁が走っておらず、
// 起動の直後に出た失敗が落ちて、読み込み中のまま止まった。殻は失敗、進み具合、合図を状態として持っている。
// 口が出来た後に起きたことは、殻がその場で評価して渡すので、問い合わせは一度でよい。
// 問い合わせが断られても、待っている間の画面のまま続ける。
// 試験のための書き出しが求められていれば（probe）、引き取った後の様子を一度渡す。札と合図は描いた時にも渡す。
Promise.resolve(invoke('boot_state')).then((s) => {
  if (!s) return;
  probing = s.probe === true;
  if (s.progress) progress = s.progress;
  if (s.failure) window.__hangarBootFail(s.failure);
  else if (s.finishing) finish();
  else report();
}).catch(() => {});
