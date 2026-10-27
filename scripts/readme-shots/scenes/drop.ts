// drop：スクリーンショットを端末へドロップする。画像のパスが端末に入り、「この崩れを直して」と送ると、偽の claude が画像を読んで返事をする。
// Hangar.app の殻は、落とされたファイルを写して `hangar:drop`（paths と位置）を頁へ送る。ブラウザではその知らせを自分で送って再現する。
import type { Scene } from '../kit.ts';

const NAME = '料金カードの崩れを直す';
const SHOT = '/Users/demo/.agent-hangar/drops/pricing-broken.png';

// 架空の料金表の、崩れた画面。カードが重なり、文字がはみ出している。
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220" viewBox="0 0 320 220">
<rect width="320" height="220" fill="#f6f7fb"/>
<rect width="320" height="24" fill="#fff"/><circle cx="14" cy="12" r="4" fill="#f87171"/><circle cx="28" cy="12" r="4" fill="#fbbf24"/><circle cx="42" cy="12" r="4" fill="#34d399"/>
<text x="16" y="52" font-size="14" font-weight="700" fill="#1f2937" font-family="sans-serif">プランを選ぶ</text>
<rect x="16" y="66" width="110" height="130" rx="8" fill="#fff" stroke="#d1d5db"/>
<text x="26" y="90" font-size="11" fill="#374151" font-family="sans-serif">フリー</text>
<text x="26" y="118" font-size="20" font-weight="700" fill="#111827" font-family="sans-serif">¥0</text>
<rect x="96" y="80" width="120" height="130" rx="8" fill="#eef2ff" stroke="#6366f1"/>
<text x="104" y="104" font-size="11" fill="#4338ca" font-family="sans-serif">スタンダード</text>
<text x="104" y="132" font-size="20" font-weight="700" fill="#312e81" font-family="sans-serif">¥1,200/月</text>
<rect x="190" y="70" width="110" height="130" rx="8" fill="#fff" stroke="#d1d5db"/>
<text x="228" y="94" font-size="11" fill="#374151" font-family="sans-serif">チーム</text>
<text x="228" y="122" font-size="20" font-weight="700" fill="#111827" font-family="sans-serif">¥4,800/月</text>
<rect x="104" y="176" width="150" height="22" rx="11" fill="#6366f1"/><text x="118" y="191" font-size="10" fill="#fff" font-family="sans-serif">スタンダードを始める</text>
</svg>`;

type W = { __drag: (t: number) => void };

const scene: Scene = {
  name: 'drop',
  kind: 'motion',
  setup(seed) {
    seed.project({ dir: 'plan-board', name: 'plan-board' });
    seed.live('drop', {
      project: 'plan-board',
      name: NAME,
      steps: [
        { typed: true },
        { ms: 700, say: '画像を見ます。' },
        { ms: 500, tool: 'Read', arg: SHOT, input: { file_path: SHOT }, out: ['Read image (41 KB)'] },
        { ms: 800, say: 'カード同士が重なり、「チーム」の金額もはみ出しています。幅を固定している CSS が原因のようです。', intent: '料金カードが重なりはみ出している画面の崩れを、CSS の幅の指定から直している。' },
        { ms: 600, tool: 'Read', arg: 'src/pricing.css', input: { file_path: 'src/pricing.css' }, out: ['Read 42 lines'] },
        {
          ms: 700, tool: 'Update', arg: 'src/pricing.css',
          input: { file_path: 'src/pricing.css', old_string: '.plan { width: 110px; }', new_string: '.plan { flex: 1 1 0; min-width: 0; }' },
          summary: 'Updated src/pricing.css with 1 addition and 1 removal',
          diff: [[' ', 11, '.plans { display: flex; gap: 12px; }'], ['-', 12, '.plan { width: 110px; }'], ['+', 12, '.plan { flex: 1 1 0; min-width: 0; }'], [' ', 13, '.plan .price { white-space: nowrap; }']],
        },
        { ms: 700, say: 'カードを横幅で等分し、重ならないようにしました。金額の長さにも合わせて縮みます。', final: true },
      ],
    });
  },
  async shoot(c) {
    const { page, close } = await c.openPage();
    const rec = await c.record(page);
    await c.sleep(500);
    await (await c.sidebarItem(page, NAME)).click();
    await c.sleep(2000);

    const box = (await page.locator('.term-host').first().boundingBox())!;
    const target = { x: Math.round(box.x + box.width * 0.45), y: Math.round(box.y + box.height * 0.5) };

    // 画面の外からサムネイルと矢印が運ばれてくる。落とす位置に着いたら hangar:drop を送り、サムネイルは消える。
    await page.evaluate(({ svg, target }) => {
      const wrap = document.createElement('div');
      wrap.id = 'shot-drag';
      wrap.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;pointer-events:none;will-change:transform;';
      const img = document.createElement('img');
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      img.style.cssText = 'position:absolute;left:14px;top:12px;width:150px;border-radius:8px;border:1px solid #d1d5db;box-shadow:0 10px 28px rgba(15,23,42,.28);background:#fff;transform:rotate(-3deg);';
      const cur = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      cur.setAttribute('width', '22'); cur.setAttribute('height', '28'); cur.setAttribute('viewBox', '0 0 22 28');
      cur.style.cssText = 'position:absolute;left:0;top:0;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4));';
      cur.innerHTML = '<path d="M2 1 L2 22 L7.5 17.5 L11 26 L14.5 24.5 L11 16.5 L18.5 16 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>';
      wrap.append(img, cur);
      wrap.style.transform = 'translate(1180px, 90px)';
      document.body.append(wrap);
      (window as unknown as W).__drag = (t) => {
        const e = 1 - Math.pow(1 - t, 3);
        wrap.style.transform = `translate(${1180 + (target.x - 1180) * e}px, ${90 + (target.y - 90) * e}px)`;
      };
    }, { svg: SVG, target });
    await c.sleep(500);
    // tsx が関数に足す __name は頁に無いので、ここは文字列で渡す。
    await page.evaluate(`new Promise((done) => {
      const t0 = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - t0) / 1300);
        window.__drag(t);
        if (t < 1) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    })`);
    await c.sleep(450);
    await page.evaluate(({ target, path }) => {
      const img = document.querySelector('#shot-drag img') as HTMLElement;
      img.style.transition = 'opacity .25s ease-out, transform .25s ease-out';
      img.style.opacity = '0';
      img.style.transform = 'rotate(-3deg) scale(.6)';
      window.dispatchEvent(new CustomEvent('hangar:drop', { detail: { paths: [path], x: target.x, y: target.y } }));
    }, { target, path: SHOT });
    await c.sleep(900);
    await page.evaluate(() => { const w = document.getElementById('shot-drag'); if (w) { w.style.transition = 'opacity .3s'; w.style.opacity = '0'; setTimeout(() => w.remove(), 400); } });
    await c.sleep(500);

    for (const ch of 'この崩れを直して') {
      await page.keyboard.insertText(ch);
      await c.sleep(110);
    }
    await c.sleep(700);
    await page.keyboard.press('Enter');
    await c.until('drop の台本', c.transcriptHas('金額の長さにも合わせて縮みます'), 40_000);
    await c.sleep(1500);
    await rec.save('drop');
    await close();
  },
};
export default scene;
