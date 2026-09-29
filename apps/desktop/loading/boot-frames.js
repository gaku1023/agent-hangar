// 起動画面のハンガーの動き。
// 値と式は docs/superpowers/specs/2026-09-29-ui-refresh/boot-animation.html の ENTRY.pendulum と frameOf が正本で、それをそのまま移した。
// 画面に依らない計算だけを置き、描くのは boot.js が受け持つ（試験は apps/desktop/test/boot.test.ts）。

const INK = '#1c1b2e';
const BLUE = '#4a63e8';
const HAZE = '#e2e7ff';
const CHEV = '#e8e6e1';
/** 札ごとのカーソルの色。杏、赤、灰、杏、杏、灰の順に巡る。 */
const CURSORS = ['#ffb86b', '#e5533d', '#b5b2c4', '#ffb86b', '#ffb86b', '#b5b2c4'];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => '#' + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');
const clamp = (t) => Math.max(0, Math.min(1, t));
const eOut = (t) => 1 - Math.pow(1 - t, 3);

// 並べ方。1 本奥へ行くごとに 0.85 倍、横へ札の幅 62 の 13%、上へ札の高さ 72 の 3.5%（静止した原図と同じ）。
const R = 0.85;
const K = 0.13 * 62;
const UP = 0.035 * 72;
/** 奥への位置 u（0 が手前、小数も取る）の札の置き場所と倍率。 */
export const geo = (u) => { const g = (1 - Math.pow(R, u)) / (1 - R); return { x: K * g, y: -UP * g, s: Math.pow(R, u) }; };

// 振り子の角速度（約 1 往復／秒）と減衰。
const W = 6.3;
const Z = 2.4;
/** 1 周期の長さ。lib.rs の BOOT_CYCLE_MS と揃える（config.test.ts が突き合わせる）。 */
export const CYCLE_MS = 1600;
const PER = CYCLE_MS / 1000;
// 周期のうち、新しい札が掛かる部分（H）、全体が奥へ送られる部分（SL）、札ごとの送りの遅れ（WV）の割合。
const H = 0.34;
const SL = 0.34;
const WV = 0.07;

/** 降りながら少しずつ傾き、掛かった角度のまま振り子として揺れ始める。d は掛かるまでの進み、tau は掛かってからの秒数。 */
const pendulum = (d, tau, landed) => {
  const A = 5;
  if (!landed) return { dy: -34 * (1 - eOut(d)), ang: A * eOut(d), op: eOut(d) };
  return { dy: 0, ang: A * Math.exp(-Z * tau) * Math.cos(W * tau), op: 1 };
};

/**
 * 時刻 T 秒の札の並び。奥の札から順に返す。
 * u は奥への位置、id は札の通し番号、ang は傾き（度）、dy は縦のずれ、op は不透明度。
 */
export function frameOf(T) {
  const n = Math.floor(T / PER);
  const f = (T / PER) % 1;
  const tSec = f * PER;
  const out = [];
  const landT = H * 0.92 * PER;
  for (let k = 0; k <= 4; k++) {
    const id = n - k;
    const local = clamp((f - H - k * WV) / SL);
    let u = k + eOut(local);
    let dy = 0;
    let op = 1;
    let ang = 0;
    const damp = 1 - Math.min(u, 3) / 5;
    const B = 3.2 * damp;
    const endT = (H + k * WV + SL) * PER;
    // 送り：動く間は後ろへ遅れ、止まったら振り子として前へ振れて戻る（角度と向きが途切れない）。
    if (local > 0 && local < 1) ang = -B * Math.sin(local * Math.PI);
    else if (local >= 1) { const tau = tSec - endT; ang = B * 0.7 * Math.exp(-Z * tau) * Math.sin(W * tau); }
    else if (k > 0) { const tau = tSec + PER - (endT - WV * PER); ang = B * 0.7 * Math.exp(-Z * tau) * Math.sin(W * tau); } // 前の周期の送りの揺れの続き
    // 先頭の札は、周期の頭で掛かる。その揺れが送りの前まで続く。
    if (k === 0) {
      const landed = tSec >= landT;
      const d = clamp(tSec / landT);
      const tau = Math.max(0, tSec - landT);
      const e = pendulum(d, tau, landed);
      if (f < H) { dy = e.dy; op = e.op; ang = e.ang; }
      else { ang += pendulum(1, tau, true).ang * (local < 1 ? 1 : Math.exp(-3 * (tSec - endT))); }
    }
    if (u > 3) op *= clamp(1 - (u - 3) / 0.8);
    if (op <= 0) continue;
    out.push({ u, id, ang, dy, op });
  }
  return out.sort((p, q) => q.u - p.u);
}

// 竿と外枠は、静止した原図（packages/ui/src/brand/logo.ts の layout）と同じ置き方にする。
const P = [0, 1, 2, 3].map(geo);
let box = [Infinity, Infinity, -Infinity, -Infinity];
for (const p of P) box = [Math.min(box[0], p.x - 31 * p.s), Math.min(box[1], p.y - 3 * p.s), Math.max(box[2], p.x + 31 * p.s), Math.max(box[3], p.y + 69 * p.s)];
const SC = Math.min(70 / (box[2] - box[0]), 66 / (box[3] - box[1]));
const TX = 50 - (SC * (box[0] + box[2])) / 2;
const TY = 51 - (SC * (box[1] + box[3])) / 2;
const R0 = geo(-1.1);
const R1 = geo(3.6);
const DEFS = `<defs><linearGradient id="RG" gradientUnits="userSpaceOnUse" x1="${R0.x}" y1="0" x2="${R1.x}" y2="0"><stop offset="0" stop-color="${INK}" stop-opacity="0"/><stop offset=".2" stop-color="${INK}"/><stop offset=".4" stop-color="${INK}"/><stop offset="1" stop-color="${HAZE}"/></linearGradient></defs>`;
const RAIL = `<path d="M${R0.x} ${R0.y - 1}L${R1.x} ${R1.y - 1}" stroke="url(#RG)" stroke-width="2.6" stroke-linecap="round"/>`;

const colors = (t, cur) => ({ ink: mix(INK, HAZE, t), blue: mix(BLUE, HAZE, t), chev: mix(CHEV, HAZE, t * 0.6), cur: mix(cur, HAZE, t * 0.45), r: mix('#ff6a55', HAZE, t), y: mix('#ffc34d', HAZE, t), g: mix('#3fb58a', HAZE, t) });
const item = (c) => `<path d="M0 10v-4a4.2 4.2 0 1 0-4.2-4.2" fill="none" stroke="${c.ink}" stroke-width="2.8" stroke-linecap="round"/><rect x="-30" y="29" width="60" height="40" rx="5" fill="${c.ink}"/>`
  + `<path d="M0 10L-31 31H31Z" fill="none" stroke="${c.blue}" stroke-width="4" stroke-linejoin="round"/>`
  + `<circle cx="-23" cy="37" r="2" fill="${c.r}"/><circle cx="-16.5" cy="37" r="2" fill="${c.y}"/><circle cx="-10" cy="37" r="2" fill="${c.g}"/>`
  + `<path d="M-23 46l7 5.5-7 5.5" fill="none" stroke="${c.chev}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="-12" y="55" width="13" height="4" rx="2" fill="${c.cur}"/>`;
const draw = (c) => {
  const p = geo(c.u);
  const t = clamp(c.u / 3) * 0.86 + Math.max(0, c.u - 3) * 0.1;
  return `<g transform="translate(${p.x.toFixed(2)} ${(p.y + c.dy).toFixed(2)}) scale(${p.s.toFixed(4)})" opacity="${c.op.toFixed(3)}"><g transform="rotate(${c.ang.toFixed(2)})">${item(colors(Math.min(t, 0.95), CURSORS[((c.id % 6) + 6) % 6]))}</g></g>`;
};

/** 時刻 T 秒の絵。viewBox 0 0 100 100 の svg の中身にする。 */
export const frameSvg = (T) => `${DEFS}<g transform="translate(${TX} ${TY}) scale(${SC})">${RAIL}${frameOf(T).map(draw).join('')}</g>`;

/** 経過 ms にいちばん近い周の境目の時刻（秒）。止めるときはこの時刻の絵で静止する。
 * 境目の絵は送りを終えた並びで、新しい札はまだ降りてきていない。 */
export const nearestBoundary = (ms) => (Math.round(ms / CYCLE_MS) * CYCLE_MS) / 1000;

/** 起動を待ち始めてから、状態の文を替えるまでの長さ。 */
export const SLOW_AFTER_MS = 3000;
/** 待ちが長いときの文。SLOW_AFTER_MS より前は null で、今の文をそのまま残す。 */
export const stillBootingText = (ms) => (ms < SLOW_AFTER_MS ? null : `まだ起動しています（${Math.floor(ms / 1000)} 秒）`);
