// palette：⌘K でコマンドパレットを開く → 「サムネ」と打つ → 会話が候補に並ぶ → ↓ と ↵ だけで開く。キーボードだけで動く。
import type { Scene } from '../kit.ts';

const TITLE = 'サムネイル一覧の読み込みを並列にする';
const OTHER = 'サムネイルのキャッシュを設計する';
const QUERY = 'サムネ';

const scene: Scene = {
  name: 'palette',
  kind: 'motion',
  watch: [
    'packages/ui/src/views/CommandPalette.tsx',
    'packages/ui/src/presenters/palette.ts',
    'packages/ui/src/keys.ts',
    'packages/server/src/search/*.ts',
    'packages/server/src/http/routes/sessions.ts',
  ],
  setup(seed) {
    seed.past({
      project: 'photo-tagger',
      title: OTHER,
      minutesAgo: 60 * 26,
      state: 'done',
      turns: [
        ['サムネイルを毎回作り直していて遅いです。キャッシュの置き方を考えてください。', [
          ['Read', { file_path: 'src/thumbs.ts' }, 'Read 61 lines'],
        ], '元の画像の更新日時と大きさをキーにして、ディスクにキャッシュする案にします。'],
      ],
    });
    seed.past({
      project: 'photo-tagger',
      title: TITLE,
      minutesAgo: 60 * 5,
      state: 'done',
      turns: [
        ['一覧を開くときのサムネイルの生成が遅いので、並列にして速くしてください。', [
          ['Read', { file_path: 'src/thumbs.ts' }, 'Read 61 lines'],
          ['Update', { file_path: 'src/thumbs.ts', old_string: 'for (const f of files) await make(f);', new_string: 'await Promise.all(files.map(make));' }, 'Updated src/thumbs.ts with 1 addition'],
        ], '生成を並列にしました。200 枚の一覧で、開くまでの時間が 4 秒から 1 秒ほどになりました。'],
        ['同時に作る数に上限は付けますか。', [], '4 本までに絞ります。メモリが跳ねないようにするためです。'],
      ],
    });
  },
  async shoot(c) {
    const { page, close } = await c.openPage();
    const rec = await c.record(page);
    await c.sleep(800);
    await page.keyboard.press('Meta+k');
    const input = page.getByRole('combobox').first();
    await input.waitFor();
    await c.sleep(1800);
    await input.pressSequentially(QUERY, { delay: 420 });
    await page.getByRole('option').filter({ hasText: TITLE }).first().waitFor();
    await c.sleep(1800);
    const target = page.getByRole('option').filter({ hasText: TITLE }).first();
    for (let i = 0; i < 8; i++) {
      if ((await target.getAttribute('aria-selected')) === 'true') break;
      await page.keyboard.press('ArrowDown');
      await c.sleep(800);
    }
    await c.sleep(700);
    await page.keyboard.press('Enter');
    await input.waitFor({ state: 'hidden' });
    await c.sleep(2600);
    await rec.save('palette');
    await close();
  },
};
export default scene;
