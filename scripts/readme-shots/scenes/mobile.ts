// mobile：スマホから新しい会話を頼む。左に PC の hangar、右にスマホの PWA を並べる。
// スマホの PWA（packages/mobile）は偽の Worker（mobile.worker.ts、手元だけ）につなぐ。実物のクラウドには何もつながない。
// スマホで書いた依頼は、封じて偽の Worker に届き、開いた中身を台本の文と突き合わせてから、PC 側で会話を起こす（偽の claude が同じ文を流す）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Frame } from 'playwright';
import type { LiveScript, Scene, ShootCtx } from '../kit.ts';
import { EPOCH, PC_ID, PHONE_ID, startFakeWorker } from './mobile.worker.ts';

const A = 'GPX ファイルの読み込みを足す';
const B = 'レシピの材料を在庫と突き合わせる';
const NEW = '歩いた距離を記録の一覧に出す';
const PROMPT = '記録の一覧に、歩いた距離と獲得標高を出してください。';
const PC_NAME = 'Mac mini';
const W = 1600;
const H = 900;

const newScript: LiveScript = {
  project: 'hiking-log',
  name: NEW,
  steps: [
    { gate: 'mobile-new' },
    { user: PROMPT, intent: '記録の一覧に、歩いた距離と獲得標高を出す。一覧を作っている部品を読んでいる。' },
    { ms: 600, say: 'まず、記録の一覧を作っている部品を確認します。' },
    { ms: 600, tool: 'Read', arg: 'src/list.ts', input: { file_path: 'src/list.ts' }, out: ['Read 52 lines'] },
    {
      ms: 700, tool: 'Update', arg: 'src/list.ts',
      input: { file_path: 'src/list.ts', old_string: 'title: log.name,', new_string: 'title: log.name,\n  distance: `${log.km} km / +${log.climb} m`,' },
      summary: 'Updated src/list.ts with 1 addition',
      diff: [[' ', 18, '    title: log.name,'], ['+', 19, '    distance: `${log.km} km / +${log.climb} m`,'], [' ', 20, '    date: log.date,']],
    },
    { ms: 600, say: '一覧の各行に、距離と獲得標高を出すようにしました。', final: true },
  ],
};

const stageHtml = (): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>mobile</title>
<style>
  html,body{margin:0;width:${W}px;height:${H}px;background:#e9edf5;font-family:-apple-system,'Hiragino Sans',sans-serif;overflow:hidden}
  .row{display:flex;gap:24px;padding:18px 22px 0;align-items:flex-start}
  .col{display:flex;flex-direction:column;gap:8px}
  .lab{font-size:15px;font-weight:600;color:#4a5568;letter-spacing:.04em;height:22px;padding-left:6px}
  .pc{width:1130px;height:812px;border:0;border-radius:14px;background:#fff;box-shadow:0 8px 30px rgba(40,55,90,.18),0 0 0 1px rgba(40,55,90,.12)}
  .bezel{width:376px;height:788px;padding:12px;border-radius:46px;background:#1b1f2a;box-shadow:0 10px 34px rgba(30,40,70,.35)}
  .phone{width:376px;height:788px;border:0;border-radius:34px;background:#fff;display:block}
</style></head><body>
<div class="row">
  <div class="col"><div class="lab">PC の hangar</div><iframe id="pc" class="pc"></iframe></div>
  <div class="col"><div class="lab">スマホ</div><div class="bezel"><iframe id="phone" class="phone"></iframe></div></div>
</div>
<script>
(async () => {
  const s = await (await fetch('/seed.json')).json();
  localStorage.setItem('hangar.mobile.pairing', JSON.stringify(s.pairing));
  const raw = Uint8Array.from(atob(s.key), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pub = btoa(String.fromCharCode(...pubRaw)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  const db = await new Promise((ok, ng) => {
    const r = indexedDB.open('hangar-mobile', 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('keys')) r.result.createObjectStore('keys'); };
    r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error);
  });
  await new Promise((ok, ng) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').put({ pub, key: pair.privateKey }, 'phone-pair');
    tx.objectStore('keys').put([{ epoch: ${EPOCH}, key }], 'phone-keys');
    tx.oncomplete = () => ok(); tx.onerror = () => ng(tx.error);
  });
  db.close();
  document.getElementById('pc').src = s.pcUrl;
  document.getElementById('phone').src = '/app/';
})();
</script></body></html>`;

const sidebar = async (f: Frame, text: string) => {
  for (const l of await f.getByText(text).all()) {
    const b = await l.boundingBox();
    if (b && b.x < 260) return l;
  }
  throw new Error(`PC のサイドバーに無い: ${text}`);
};

const scene: Scene = {
  name: 'mobile',
  kind: 'motion',
  setup(seed) {
    seed.project({ dir: 'hiking-log', name: 'hiking-log' });
    seed.project({ dir: 'pantry-app', name: 'pantry-app' });
    seed.live('mobileA', {
      project: 'hiking-log',
      name: A,
      steps: [
        { gate: 'mobile-a' },
        { user: 'GPX ファイルを読んで、歩いた経路を記録に足せるようにしてください。', intent: 'GPX ファイルから経路を読み、記録に足す処理を入れる。' },
        { ms: 500, tool: 'Read', arg: 'src/gpx.ts', input: { file_path: 'src/gpx.ts' }, out: ['Read 40 lines'] },
        { ms: 600, say: 'GPX を読んで、経路の点を記録に足す処理を入れました。', final: true },
      ],
    });
    seed.live('mobileB', {
      project: 'pantry-app',
      name: B,
      steps: [
        { gate: 'mobile-b' },
        { user: 'レシピの材料と在庫を突き合わせて、足りないものを出してください。', intent: 'レシピの材料と在庫を突き合わせ、足りないものを出す。テストの実行の許可を待っている。' },
        { ms: 500, say: '突き合わせる処理を書きました。テストを走らせて確かめます。' },
        { ms: 600, ask: { tool: 'Bash', input: 'npm test', description: '在庫の突き合わせのテストを走らせる', question: 'Do you want to proceed?' } },
      ],
    });
  },
  async shoot(c: ShootCtx) {
    const { e } = c;
    const rawKey = crypto.randomBytes(32);
    const worker = await startFakeWorker({
      rawKey,
      pcName: PC_NAME,
      stageHtml,
      seedJson: (origin) => ({
        pairing: { url: origin, token: 'demo-phone-token', deviceId: PHONE_ID, joinedAt: Date.now() - 3 * 86_400_000 },
        key: rawKey.toString('base64'),
        pcUrl: `${e.base}/?t=${e.token}`,
      }),
    });
    let newId: string | null = null;
    let newDone = false;
    const nowRow = (now: number) => ({ statusAt: now - 20_000, startedAt: now - 40 * 60_000 });
    worker.setFeed((now) => ({
      caps: { asks: false, images: false, effort: false },
      accounts: [{ id: 'acc-main', name: 'メイン', color: '#4f6bed', fiveHour: 31, sevenDay: 14 }],
      projects: [
        { id: c.projectIds['hiking-log']!, name: 'hiking-log', lastUsedAt: now - 3 * 60_000 },
        { id: c.projectIds['pantry-app']!, name: 'pantry-app', lastUsedAt: now - 9 * 60_000 },
      ],
      live: [
        {
          sessionId: c.live.mobileB!, projectId: c.projectIds['pantry-app']!, projectName: 'pantry-app', title: B, accountId: 'acc-main', status: 'waiting',
          statusAt: now - 70_000, startedAt: now - 25 * 60_000,
          waiting: { kind: 'permission', text: 'Bash: npm test を実行してよいか' }, intent: 'レシピの材料と在庫を突き合わせ、足りないものを出す。', rcUrl: null,
        },
        {
          sessionId: c.live.mobileA!, projectId: c.projectIds['hiking-log']!, projectName: 'hiking-log', title: A, accountId: 'acc-main', status: 'idle',
          ...nowRow(now), waiting: null, intent: 'GPX から経路を読み、記録に足す処理を入れた。', rcUrl: null,
        },
        ...(newId
          ? [{
              sessionId: newId, projectId: c.projectIds['hiking-log']!, projectName: 'hiking-log', title: NEW, accountId: 'acc-main', status: (newDone ? 'idle' : 'busy') as 'idle' | 'busy',
              statusAt: now - 2_000, startedAt: now - 8_000, waiting: null, intent: '記録の一覧に、歩いた距離と獲得標高を出す。', rcUrl: null,
            }]
          : []),
      ],
      returns: [],
      done: [],
    }));

    // PC 側の用意。A は終わらせ、B は許可待ちにしておく。新しい会話の台本は、依頼が届く前に live.json へ足す。
    const live = JSON.parse(fs.readFileSync(e.liveFile, 'utf8')) as Record<string, LiveScript>;
    live.mobileNew = newScript;
    fs.writeFileSync(e.liveFile, JSON.stringify(live));
    c.gate('mobile-a');
    c.gate('mobile-b');
    await c.until('A の台本', c.transcriptHas('経路の点を記録に足す処理を入れました'), 30_000);
    await c.until('B の台本', c.transcriptHas('突き合わせる処理を書きました'), 30_000);
    await c.sleep(1500);

    // 依頼が届いたら、少し置いて PC が受け取り、さらに置いて会話を起こす。
    worker.onLaunch((l) => {
      void (async () => {
        if (l.prompt !== PROMPT) throw new Error(`届いた依頼の文が違います: ${l.prompt}`);
        await c.sleep(900);
        worker.claim(l.id);
        await c.sleep(1000);
        const r = await fetch(`${e.base}/api/runs`, {
          method: 'POST',
          headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ projectId: l.projectId, name: NEW }),
        });
        if (!r.ok) throw new Error(`POST /runs ${r.status}`);
        const run = (await r.json()) as { id?: string; sessionId?: string };
        newId = run.sessionId ?? run.id ?? '';
        await worker.answer(l.id, { ok: true, sessionId: newId, title: NEW });
      })().catch((err) => { console.error(err); process.exitCode = 1; });
    });

    const { page, close } = await c.openPage({ viewport: { width: W, height: H }, url: `${worker.origin}/stage`, frameable: true });
    try {
      const find = (test: (url: string) => boolean): Frame | undefined => page.frames().find((x) => test(x.url()));
      await c.until('枠', () => !!find((u) => u.startsWith(e.base)) && !!find((u) => u.startsWith(worker.origin) && u.includes('/app/')), 30_000);
      const pc = find((u) => u.startsWith(e.base))!;
      const phone = find((u) => u.startsWith(worker.origin) && u.includes('/app/'))!;
      await pc.getByText('ホーム', { exact: true }).first().waitFor();
      await phone.getByText('入力待ち').first().waitFor();
      await c.sleep(1200);

      const rec = await c.record(page);
      await c.sleep(1300);
      // 新しい会話を開き、プロジェクトを選び、依頼の文を打って送る。
      await phone.getByRole('button', { name: '＋ 新しい会話' }).click();
      await c.sleep(800);
      await phone.locator('.ns').getByText('hiking-log', { exact: true }).click();
      await c.sleep(500);
      const box = phone.getByRole('textbox').first();
      await box.click();
      await page.keyboard.type(PROMPT, { delay: 45 });
      await c.sleep(500);
      await phone.locator('.ns-start').click();
      await phone.getByText('会話が始まりました').waitFor({ timeout: 30_000 });
      await c.sleep(500);
      // PC 側の端末にその依頼が届く。
      await (await sidebar(pc, NEW)).click();
      await c.sleep(600);
      c.gate('mobile-new');
      await c.until('新しい会話の台本', c.transcriptHas('距離と獲得標高を出すようにしました'), 40_000);
      newDone = true;
      await c.sleep(600);
      await phone.getByText('受信箱へ').click();
      await phone.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await c.sleep(1700);
      await rec.save('mobile', { holdMs: 1000 });
    } finally {
      await close();
      await worker.close();
    }
  },
};
export default scene;
