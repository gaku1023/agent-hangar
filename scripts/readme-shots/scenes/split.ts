// split：別の会話を並べて動かす。Alt を押しながらサイドバーの 2 つ目を押して分割し、最後に境目をドラッグする。
import type { Scene } from '../kit.ts';

const A = 'RSS フィードにカテゴリを出す';
const B = '気温の単位を設定で決める';

const scene: Scene = {
  name: 'split',
  kind: 'motion',
  setup(seed) {
    seed.live('split', {
      project: 'blog-engine',
      name: A,
      steps: [
        { gate: 'split' },
        { user: 'RSS の各記事に、タグを category として出してください。', intent: 'RSS の各記事に、タグを <category> として出す。フィードを作る feed.ts を読んでいる。' },
        { ms: 700, say: 'フィードを作っている feed.ts を読みます。' },
        { ms: 700, tool: 'Read', arg: 'src/feed.ts', input: { file_path: 'src/feed.ts' }, out: ['Read 61 lines'] },
        {
          ms: 800, tool: 'Update', arg: 'src/feed.ts',
          input: { file_path: 'src/feed.ts', old_string: '</pubDate>', new_string: '</pubDate>\n${categories(post)}' },
          summary: 'Updated src/feed.ts with 1 addition',
          diff: [[' ', 27, '    <pubDate>${post.date.toUTCString()}</pubDate>'], ['+', 28, '    ${categories(post)}'], [' ', 29, '  </item>']],
        },
        { ms: 800, intent: 'feed.ts に category を足した。ビルドが通るかを確かめている。', tool: 'Bash', arg: 'npm run build', input: { command: 'npm run build' }, out: ['> blog-engine@1.4.0 build', '> tsc && node dist/build.js', '', 'rendered 48 posts, 12 tags', 'wrote public/feed.xml'], lineMs: 280 },
        { ms: 700, say: '各 item に <category> を出すようにして、ビルドも通りました。', final: true },
      ],
    });
    seed.live('split2', {
      project: 'weather-cli',
      name: B,
      steps: [
        { gate: 'split2' },
        { user: '設定ファイルで気温の単位を決められるようにしてください。', intent: '気温の単位（摂氏か華氏）を設定ファイルで決められるようにする。設定を読む config.ts を見ている。' },
        { ms: 700, say: 'まず、設定を読んでいる config.ts を確認します。' },
        { ms: 700, tool: 'Read', arg: 'src/config.ts', input: { file_path: 'src/config.ts' }, out: ['Read 29 lines'] },
        {
          ms: 800, intent: 'config.ts に unit の項目を足し、既定は摂氏にしている。', tool: 'Update', arg: 'src/config.ts',
          input: { file_path: 'src/config.ts', old_string: 'city: string;', new_string: "city: string;\n  unit: 'C' | 'F';" },
          summary: 'Updated src/config.ts with 1 addition',
          diff: [[' ', 8, '  city: string;'], ['+', 9, "  unit: 'C' | 'F';"], [' ', 10, '};']],
        },
        { ms: 800, tool: 'Bash', arg: 'npm test', input: { command: 'npm test' }, out: ['', '  ✓ defaults to C (4 ms)', '  ✓ reads unit from config (6 ms)', '', 'Tests: 2 passed, 2 total'], lineMs: 280 },
        { ms: 700, say: '設定ファイルの unit に C か F を書けるようになりました。書かなければ摂氏です。', final: true },
      ],
    });
  },
  async shoot(c) {
    const { page, close } = await c.openPage();
    const rec = await c.record(page);
    await c.sleep(600);
    await (await c.sidebarItem(page, A)).click();
    await c.sleep(1300);
    await (await c.sidebarItem(page, B)).click({ modifiers: ['Alt'] });
    await c.sleep(1800);
    c.gate('split');
    await c.sleep(500);
    c.gate('split2');
    await c.until('split の台本', () => c.transcriptHas('ビルドも通りました')() && c.transcriptHas('書かなければ摂氏です')(), 40_000);
    await c.sleep(1200);
    // 境目を左右にドラッグして、幅を変えられるところを見せる。
    const div = page.locator('.pane-divider').first();
    const b = (await div.boundingBox())!;
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 220, y, { steps: 24 });
    await c.sleep(500);
    await page.mouse.move(x + 60, y, { steps: 24 });
    await page.mouse.up();
    await c.sleep(1000);
    await rec.save('split');
    await close();
  },
};
export default scene;
