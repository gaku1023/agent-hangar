// hero：いま何が起きているか。生きた会話を開き、端末と右欄が台本どおりに進むところを撮る。
import type { Scene } from '../kit.ts';

const NAME = 'EXIF の撮影日時をタグにする';

const scene: Scene = {
  name: 'hero',
  kind: 'motion',
  watch: [
    'packages/ui/src/views/{SessionScreen,TerminalPane,NowCard,SummaryCard,TocPane,TurnIndex,Transcript,ToolGroup,ToolItem,PaneHeader,TabStrip}.tsx',
    'packages/ui/src/presenters/{live,nowCard,session,turns,tools,toolGroups,heading}.ts',
    'packages/ui/src/mediator/{live,sessionView}.ts',
    'packages/ui/src/runtime/{terminals,xterm,xtermSetup,terminalLinks}.ts',
    'packages/server/src/live/*.ts',
  ],
  setup(seed) {
    seed.live('hero', {
      project: 'photo-tagger',
      name: NAME,
      steps: [
        { gate: 'hero' },
        { user: '写真の EXIF から撮影日時を読んで、「2026-春」のようなタグを自動で付けられるようにしてください。', intent: '写真の EXIF の撮影日時から、季節のタグ（2026-春 など）を自動で付ける処理を足す。まず既存のタグ付けを読んでいる。' },
        { ms: 900, say: 'まず、いまのタグ付けの処理と、EXIF を読む処理があるかを確認します。' },
        { ms: 700, tool: 'Read', arg: 'src/tagger.ts', input: { file_path: 'src/tagger.ts' }, out: ['Read 84 lines'] },
        { ms: 600, tool: 'Grep', arg: 'exifr', input: { pattern: 'exifr' }, out: ['package.json:14:    "exifr": "^7.1.3"', 'src/meta.ts:3:import exifr from "exifr"'] },
        { ms: 800, say: 'meta.ts がすでに exifr を使っています。撮影日時の読み出しを足して、季節のタグに直します。', intent: 'meta.ts の exifr を使って撮影日時を読み、tagger.ts で季節のタグに直す変更を入れている。' },
        {
          ms: 800, tool: 'Update', arg: 'src/tagger.ts',
          input: { file_path: 'src/tagger.ts', old_string: 'const tags: string[] = [];', new_string: 'const tags: string[] = [];\n  const taken = await readTakenAt(file);\n  if (taken) tags.push(seasonTag(taken));' },
          summary: 'Updated src/tagger.ts with 2 additions',
          diff: [[' ', 12, '  const tags: string[] = [];'], ['+', 13, '  const taken = await readTakenAt(file);'], ['+', 14, '  if (taken) tags.push(seasonTag(taken));'], [' ', 15, '  for (const rule of rules) {']],
        },
        { ms: 900, intent: '変更は入った。npm test で、撮影日時の読み出しと季節のタグを確かめている。', tool: 'Bash', arg: 'npm test', input: { command: 'npm test' }, out: ['', '  ✓ reads DateTimeOriginal (12 ms)', '  ✓ maps March to 春 (3 ms)', '  ✓ skips photos without EXIF (4 ms)', '', 'Tests: 3 passed, 3 total'], lineMs: 260 },
        { ms: 700, say: '撮影日時から 2026-春 のようなタグを付けられるようになりました。EXIF が無い写真は、これまでどおりタグを付けません。テストは 3 本とも通っています。', final: true },
      ],
    });
  },
  async shoot(c) {
    const { page, close } = await c.openPage();
    const rec = await c.record(page);
    await c.sleep(600);
    await (await c.sidebarItem(page, NAME)).click();
    await c.sleep(1400);
    c.gate('hero');
    await c.until('hero の台本', c.transcriptHas('テストは 3 本とも通っています'), 40_000);
    await c.sleep(1800);
    await rec.save('hero');
    await close();
  },
};
export default scene;
