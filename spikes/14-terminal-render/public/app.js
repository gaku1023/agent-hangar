import { Terminal as XTerm } from '/nm/@xterm/xterm/lib/xterm.mjs';
import { FitAddon as XFit } from '/nm/@xterm/addon-fit/lib/addon-fit.mjs';
import { WebglAddon } from '/nm/@xterm/addon-webgl/lib/addon-webgl.mjs';
import { Unicode11Addon } from '/nm/@xterm/addon-unicode11/lib/addon-unicode11.mjs';
import * as G from '/nm/ghostty-web/dist/ghostty-web.js';

const FONT_NOW = "'JetBrains Mono Variable', Menlo, monospace"; // いまの hangar と同じ
const FONT_FULL = "'JBM Full', Menlo, monospace"; // 罫線・ブロック文字まで入った JetBrains Mono 本体
const FONT_MENLO = 'Menlo, monospace';
const THEME = { background: '#1c1b2e', foreground: '#e8e6f0' };

// 描画方式 × 行の高さ × フォント × 自前グリフの有無
export const VARIANTS = [
  { id: 'now', title: '現状: xterm DOM / lh 1.2 / fontsource', lib: 'xterm', gl: false, lh: 1.2, font: FONT_NOW },
  { id: 'dom-lh1', title: 'xterm DOM / lh 1.0 / fontsource', lib: 'xterm', gl: false, lh: 1.0, font: FONT_NOW },
  { id: 'dom-full', title: 'xterm DOM / lh 1.2 / JetBrains Mono 本体', lib: 'xterm', gl: false, lh: 1.2, font: FONT_FULL },
  { id: 'dom-full-lh1', title: 'xterm DOM / lh 1.0 / JetBrains Mono 本体', lib: 'xterm', gl: false, lh: 1.0, font: FONT_FULL },
  { id: 'dom-menlo', title: 'xterm DOM / lh 1.2 / Menlo', lib: 'xterm', gl: false, lh: 1.2, font: FONT_MENLO },
  { id: 'gl', title: 'xterm WebGL / lh 1.2 / fontsource', lib: 'xterm', gl: true, lh: 1.2, font: FONT_NOW },
  { id: 'gl-lh1', title: 'xterm WebGL / lh 1.0 / fontsource', lib: 'xterm', gl: true, lh: 1.0, font: FONT_NOW },
  { id: 'gl-nocustom', title: '対照: xterm WebGL / lh 1.2 / customGlyphs: false', lib: 'xterm', gl: true, lh: 1.2, font: FONT_NOW, customGlyphs: false },
  { id: 'gl-u11', title: 'xterm WebGL / lh 1.2 / unicode11', lib: 'xterm', gl: true, lh: 1.2, font: FONT_NOW, u11: true },
  { id: 'ghostty', title: 'ghostty-web / fontsource', lib: 'ghostty', font: FONT_NOW },
  { id: 'ghostty-full', title: 'ghostty-web / JetBrains Mono 本体', lib: 'ghostty', font: FONT_FULL },
];

let ghosttyReady = null;
async function make(v, cols, rows) {
  if (v.lib === 'ghostty') {
    ghosttyReady ??= G.init();
    await ghosttyReady;
    const t = new G.Terminal({ cols, rows, fontSize: 13, fontFamily: v.font, theme: THEME, scrollback: 5000, cursorBlink: true });
    const fit = new G.FitAddon(); t.loadAddon(fit);
    return { t, fit, info: () => 'canvas2d' };
  }
  const t = new XTerm({ cols, rows, fontFamily: v.font, fontSize: 13, lineHeight: v.lh, cursorBlink: true, scrollback: 5000, theme: THEME, customGlyphs: v.customGlyphs ?? true, allowProposedApi: true });
  const fit = new XFit(); t.loadAddon(fit);
  let info = 'dom';
  t._afterOpen = () => {
    if (v.u11) { t.loadAddon(new Unicode11Addon()); t.unicode.activeVersion = '11'; }
    if (v.gl) {
      try { const gl = new WebglAddon(); gl.onContextLoss(() => { info = 'webgl(lost)'; gl.dispose(); }); t.loadAddon(gl); info = 'webgl'; } catch (e) { info = 'webgl失敗: ' + e.message; }
    }
  };
  return { t, fit, info: () => info };
}

async function fontsReady() {
  await Promise.all([
    document.fonts.load("13px 'JetBrains Mono Variable'"),
    document.fonts.load("13px 'JBM Full'"),
    document.fonts.load("13px 'JBM Full'", '█▛▜─│'),
  ]);
}

const SAMPLE = [
  '\x1b[1mブロック\x1b[0m  ▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟',
  '\x1b[38;2;215;119;87m ▐▛███▜▌   ▗▄▄▄▖  ██████ \x1b[0m',
  '\x1b[38;2;215;119;87m▝▜█████▛▘  ▐███▌  ██████ \x1b[0m',
  '\x1b[38;2;215;119;87m  ▘▘ ▝▝    ▝▀▀▀▘  ██████ \x1b[0m',
  '\x1b[1m罫線\x1b[0m  ┌─┬─┐ ╭──╮ ╔═╦═╗ ┏━┳━┓',
  '      │ │ │ │  │ ║ ║ ║ ┃ ┃ ┃',
  '      ├─┼─┤ ╰──╯ ╠═╬═╣ ┣━╋━┫',
  '      └─┴─┘      ╚═╩═╝ ┗━┻━┛  ────────────────',
  '\x1b[1m点字/記号\x1b[0m ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏  ✻ ✽ ✢ · ● ◯ ⏺ ⎿ ↯ ✓ ✗ ❯ ›',
  '\x1b[1m日本語\x1b[0m  こんにちは、端末の描画テスト｜全角ｱｲｳ｜漢字の幅',
  '\x1b[1m絵文字\x1b[0m  🙂 👍 🚀 ⚠️ ✅ 🇯🇵 👨‍👩‍👧 |← 桁ずれ確認',
  '\x1b[1m色\x1b[0m  ' + Array.from({ length: 24 }, (_, i) => `\x1b[48;2;${i * 10};${80 + i * 5};${200 - i * 6}m  `).join('') + '\x1b[0m',
  '\x1b[1m装飾\x1b[0m  \x1b[1m太字\x1b[0m \x1b[3m斜体\x1b[0m \x1b[4m下線\x1b[0m \x1b[4:3m波線\x1b[0m \x1b[9m取消\x1b[0m \x1b[2m薄い\x1b[0m \x1b[7m反転\x1b[0m',
  '1234567890123456789012345678901234567890 ← 桁の目盛り',
].join('\r\n');

function cell(parent, title, note) {
  const c = document.createElement('div'); c.className = 'cell';
  c.innerHTML = `<h2></h2><p class="note"></p><div class="term"></div>`;
  c.querySelector('h2').textContent = title;
  c.querySelector('.note').textContent = note ?? '';
  parent.append(c);
  return c;
}

async function replay() {
  await fontsReady();
  const cap = await (await fetch('/capture.json')).json();
  const root = document.getElementById('root');
  root.innerHTML = '<h1>端末描画の見比べ（記録した Claude Code の起動画面と、文字の見本）</h1><div class="grid"></div>';
  const grid = root.querySelector('.grid');
  const only = new URLSearchParams(location.search).get('only');
  for (const v of VARIANTS.filter((x) => !only || only.split(',').includes(x.id))) {
    for (const [kind, cols, rows, feed] of [['capture', cap.cols, 12, null], ['sample', 64, 14, SAMPLE]]) {
      const c = cell(grid, v.title, kind === 'capture' ? 'Claude Code 起動画面（上 12 行）' : '文字の見本');
      c.dataset.variant = v.id; c.dataset.kind = kind;
      const { t, info } = await make(v, cols, kind === 'capture' ? cap.rows : rows);
      const host = c.querySelector('.term');
      t.open(host); t._afterOpen?.();
      if (feed) t.write(feed);
      else { for (const [, d] of cap.chunks) t.write(d); }
      await new Promise((r) => setTimeout(r, 300));
      if (kind === 'capture') { host.classList.add('crop'); host.style.height = `${Math.ceil(host.firstElementChild.getBoundingClientRect().height / cap.rows * 12) + 12}px`; }
      c.querySelector('.note').textContent += ` — 描画: ${info()}`;
    }
  }
  document.body.dataset.done = '1';
}

async function live(id, cmd) {
  await fontsReady();
  const v = VARIANTS.find((x) => x.id === id) ?? VARIANTS[0];
  const root = document.getElementById('root');
  root.className = 'live';
  const c = cell(root, `ライブ: ${v.title} / ${cmd}`, '日本語の変換入力、スクロール、選択とコピーを試す');
  const { t, fit, info } = await make(v, 120, 40);
  t.open(c.querySelector('.term')); t._afterOpen?.();
  fit.fit();
  window.__t = t;
  c.querySelector('.note').textContent += ` — 描画: ${info()}`;
  const ws = new WebSocket(`ws://${location.host}/pty?cmd=${cmd}`);
  ws.onopen = () => { ws.send(JSON.stringify({ t: 'resize', cols: t.cols, rows: t.rows })); document.body.dataset.live = '1'; };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'data') t.write(m.d); };
  t.onData((d) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'data', d })));
  t.onResize(({ cols, rows }) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'resize', cols, rows })));
  addEventListener('resize', () => fit.fit());
  t.focus();
}

const q = new URLSearchParams(location.search);
if (q.get('live')) live(q.get('live'), q.get('cmd') === 'zsh' ? 'zsh' : 'claude');
else if (!q.get('stress')) replay().catch((e) => { document.body.dataset.done = 'err'; document.body.append(String(e.stack ?? e)); });

// ?stress=N: WebGL の端末を N 枚開き、描画の文脈を失った枚数を数える（hangar はタブごとに xterm を持ち続けるため）。
if (q.get('stress')) (async () => {
  await fontsReady();
  const n = Number(q.get('stress')); let lost = 0; const order = [];
  const root = document.getElementById('root');
  for (let i = 0; i < n; i++) {
    const host = document.createElement('div'); host.style.cssText = 'width:300px;height:60px;display:inline-block;margin:2px'; root.append(host);
    const t = new XTerm({ cols: 30, rows: 3, fontFamily: FONT_NOW, fontSize: 13 });
    t.open(host);
    const gl = new WebglAddon(); gl.onContextLoss(() => { lost++; order.push(i); gl.dispose(); }); t.loadAddon(gl);
    t.write(`tab ${i} ▐▛███▜▌`);
  }
  await new Promise((r) => setTimeout(r, 6000));
  document.body.dataset.stress = JSON.stringify({ n, lost, order });
})();
