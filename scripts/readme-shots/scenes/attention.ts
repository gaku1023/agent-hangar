// attention：手が要るものだけ知らせる。3 本が動き、1 本が許可を求めて止まる。要対応が増え、開いて許可すると流れ出す。
import type { Scene } from '../kit.ts';

const A = '画像の縮小を並列にする';
const B = '依存パッケージを更新する';
const C = '週間予報の表示を足す';

const scene: Scene = {
  name: 'attention',
  kind: 'motion',
  watch: [
    'packages/ui/src/views/{SessionScreen,TerminalPane,NowCard,NoticeList,ToastStack}.tsx',
    'packages/ui/src/presenters/{home,readiness,sessions,notices,toasts,live}.ts',
    'packages/ui/src/mediator/{live,notices,notify,arrived,sidebar}.ts',
    'packages/server/src/sessions/{permissionAsks,agentAsks,questionHook,stopNotices}.ts',
    'packages/server/src/live/*.ts',
  ],
  setup(seed) {
    seed.live('attA', {
      project: 'photo-tagger',
      name: A,
      steps: [
        { gate: 'attA' },
        { user: 'サムネイルの縮小を、4 並列で回せるようにしてください。', intent: 'サムネイルの縮小を並列で回す。まず現在の処理を読んでいる。' },
        { ms: 700, say: '縮小を行っている thumbs.ts を読みます。' },
        { ms: 700, tool: 'Read', arg: 'src/thumbs.ts', input: { file_path: 'src/thumbs.ts' }, out: ['Read 73 lines'] },
        {
          ms: 900, intent: 'thumbs.ts の縮小を、並列数を持つキューで回す形に直している。', tool: 'Update', arg: 'src/thumbs.ts',
          input: { file_path: 'src/thumbs.ts', old_string: 'for (const f of files) await resize(f);', new_string: 'await pool(4, files, resize);' },
          summary: 'Updated src/thumbs.ts with 1 addition',
          diff: [[' ', 31, '  const files = await list(dir);'], ['-', 32, '  for (const f of files) await resize(f);'], ['+', 32, '  await pool(4, files, resize);']],
        },
        { ms: 900, tool: 'Bash', arg: 'npm test', input: { command: 'npm test' }, out: ['', '  ✓ resizes in parallel (31 ms)', '  ✓ keeps output order (9 ms)', '', 'Tests: 2 passed, 2 total'], lineMs: 300 },
        { ms: 700, say: '縮小を 4 並列で回すようにしました。出力の順番は変わらず、テストも通っています。', final: true },
      ],
    });
    seed.live('attB', {
      project: 'blog-engine',
      name: B,
      steps: [
        { gate: 'attB' },
        { user: '古くなった依存パッケージを更新して、ビルドが通るか確かめてください。', intent: '古い依存パッケージを更新してビルドを確かめる。まず古いものの一覧を出している。' },
        { ms: 800, say: 'まず、古くなっているパッケージを調べます。' },
        { ms: 700, tool: 'Bash', arg: 'npm outdated', input: { command: 'npm outdated' }, out: ['Package   Current  Latest', 'marked    12.0.1   14.1.0', 'dayjs     1.11.9   1.11.13'], lineMs: 200 },
        { ms: 900, say: 'marked と dayjs が古いので、更新します。', intent: 'marked と dayjs を更新する。npm install の許可を待っている。' },
        { ms: 700, ask: { tool: 'Bash', input: 'npm install marked@14.1.0 dayjs@1.11.13', description: '依存パッケージを更新する', question: 'Do you want to proceed?' } },
        { ms: 600, tool: 'Bash', arg: 'npm install marked@14.1.0 dayjs@1.11.13', input: { command: 'npm install marked@14.1.0 dayjs@1.11.13' }, out: ['added 2 packages, changed 2 packages', '', 'found 0 vulnerabilities'], lineMs: 300 },
        { ms: 700, tool: 'Bash', arg: 'npm run build', input: { command: 'npm run build' }, out: ['rendered 48 posts, 12 tags', 'wrote public/feed.xml'], lineMs: 250 },
        { ms: 700, say: 'marked と dayjs を更新し、ビルドも通りました。', final: true },
      ],
    });
    seed.live('attC', {
      project: 'weather-cli',
      name: C,
      steps: [
        { gate: 'attC' },
        { user: '今日だけでなく、週間予報も表示できるようにしてください。', intent: '週間予報の表示を足す。まず今日の予報を出している forecast.ts を読んでいる。' },
        { ms: 900, say: 'いまの予報の表示を確認します。' },
        { ms: 700, tool: 'Read', arg: 'src/forecast.ts', input: { file_path: 'src/forecast.ts' }, out: ['Read 58 lines'] },
        { ms: 800, tool: 'Grep', arg: 'daily', input: { pattern: 'daily' }, out: ['src/api.ts:22:  daily: Day[]', 'src/forecast.ts:40:  const today = data.daily[0]'], lineMs: 200 },
        {
          ms: 900, intent: 'forecast.ts に 7 日分を並べる処理を足している。', tool: 'Update', arg: 'src/forecast.ts',
          input: { file_path: 'src/forecast.ts', old_string: 'const today = data.daily[0];', new_string: 'const week = data.daily.slice(0, 7);' },
          summary: 'Updated src/forecast.ts with 1 addition',
          diff: [[' ', 39, '  const data = await fetchDaily(city);'], ['-', 40, '  const today = data.daily[0];'], ['+', 40, '  const week = data.daily.slice(0, 7);']],
        },
        { ms: 900, tool: 'Bash', arg: 'npm test', input: { command: 'npm test' }, out: ['', '  ✓ prints 7 days (6 ms)', '  ✓ falls back to today (3 ms)', '', 'Tests: 2 passed, 2 total'], lineMs: 300 },
        { ms: 700, say: '--week を付けると 7 日分を表示するようにしました。', final: true },
      ],
    });
  },
  async shoot(c) {
    const { page, close } = await c.openPage();
    const rec = await c.record(page);
    await c.sleep(900);
    c.gate('attA');
    await c.sleep(500);
    c.gate('attC');
    await c.sleep(500);
    c.gate('attB');
    // B が許可を求めて止まるまで、ホームのまま見せる。
    await c.until('許可待ち', c.transcriptHas('marked と dayjs が古い'), 30_000);
    await c.sleep(2400);
    await (await c.sidebarItem(page, B)).click();
    await c.sleep(3000);
    // 端末に 1 を打って許可する。
    await page.locator('.xterm').first().click();
    await c.sleep(900);
    await page.keyboard.press('1');
    await c.until('B の台本', c.transcriptHas('ビルドも通りました'), 30_000);
    await c.sleep(1500);
    await rec.save('attention');
    await close();
  },
};
export default scene;
