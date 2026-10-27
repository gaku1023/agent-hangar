// agents：Claude Code・Codex・opencode の会話が、同じ画面で動く。3 本を画面分割で並べ、それぞれの端末が流れる。
// Codex と opencode は偽物（agents.fakes.ts）。設定の「連携」を有効にし、API で起動する。撮り終えたら無効に戻し、会話を消す。
import type { Scene } from '../kit.ts';
import { api } from '../env.ts';
import { codexScript, installAgentFakes, opencodeScript } from './agents.fakes.ts';

const CLAUDE = 'レシピの材料を g に統一する';
const CODEX = '買い物リストを売り場の順に並べる';
const OPENCODE = '分量の換算にテストを足す';
const PROJECT = 'recipe-box';

const claudeSteps = [
  { gate: 'agents-claude' },
  { user: 'レシピの材料の単位が、g と グラム と gram で混ざっています。g にそろえてください。', intent: 'レシピの材料の単位の表記ゆれ（g・グラム・gram）を g にそろえる。まず単位を読む処理を探している。' },
  { ms: 700, say: 'まず、単位を読んでいる処理を探します。' },
  { ms: 600, tool: 'Grep', arg: 'gram', input: { pattern: 'gram' }, out: ['src/units.ts:9:  gram: "g",', 'src/units.ts:10:  グラム: "g",'] },
  { ms: 800, tool: 'Edit', arg: 'src/units.ts', input: { file_path: 'src/units.ts', old_string: 'gram: "g",', new_string: 'gram: "g",\n  g: "g",' }, out: ['Updated src/units.ts', 'with 1 addition'] },
  { ms: 800, tool: 'Bash', arg: 'npm test', input: { command: 'npm test' }, out: ['', '  ✓ normalizes gram to g (3 ms)', '  ✓ normalizes グラム to g (2 ms)', '', 'Tests: 2 passed, 2 total'], lineMs: 260 },
  { ms: 700, say: '単位の表記は g にそろいました。テストは 2 本とも通っています。', final: true },
];

const codexSteps = codexScript({
  gate: 'agents-codex',
  cwd: '~/recipe-box',
  prompt: '買い物リストを、売り場の順（野菜、肉、乾物）に並べてください。',
  read: 'src/shopping.ts',
  edit: { file: 'src/shopping.ts', summary: '', rows: [[' ', 14, 'function sortList(items) {'], ['-', 15, '  return sort(byName);'], ['+', 15, '  return sort(bySection);'], [' ', 16, '}']] },
  test: { cmd: 'npm test', lines: ['  ✓ sorts by section (4 ms)', '  ✓ keeps order (2 ms)', '', 'Tests: 2 passed, 2 total'] },
  done: '売り場の順（野菜、肉、乾物）に並べるようにしました。テストは 2 本とも通っています。',
});

const opencodeSteps = opencodeScript({
  gate: 'agents-opencode',
  prompt: '分量を大さじと g で換算する関数に、テストを足してください。',
  read: 'src/convert.ts',
  edit: { file: 'test/convert.test.ts', rows: [[' ', 6, "describe('toGram', () => {"], ['+', 7, "  it('tbsp is 15 g', () => {"], ['+', 8, "    expect(toGram(1,'tbsp'))"], ['+', 9, '      .toBe(15);'], [' ', 10, '  });']] },
  test: { cmd: 'npm test', lines: ['  ✓ tbsp is 15 g (2 ms)', '', 'Tests: 1 passed, 1 total'] },
  done: '大さじから g への換算のテストを足して、通ることを確かめました。',
});

const scene: Scene = {
  name: 'agents',
  kind: 'motion',
  setup(seed) {
    seed.project({ dir: PROJECT, name: PROJECT });
    seed.live('agents', { project: PROJECT, name: CLAUDE, steps: claudeSteps });
  },
  async shoot(c) {
    installAgentFakes(c.e, { codex: codexSteps, opencode: opencodeSteps });
    await api(c.e, 'PATCH', '/settings', { codexEnabled: true, opencodeEnabled: true });
    const started: string[] = [];
    const { page, close } = await c.openPage();
    try {
      const projectId = c.projectIds[PROJECT]!;
      const cx = await api<{ sessionId?: string; id?: string }>(c.e, 'POST', '/runs', { projectId, name: CODEX, agent: 'codex', prompt: '買い物リストを、売り場の順（野菜、肉、乾物）に並べてください。' });
      started.push(cx.id ?? '');
      const oc = await api<{ sessionId?: string; id?: string }>(c.e, 'POST', '/runs', { projectId, name: OPENCODE, agent: 'opencode', prompt: '分量を大さじと g で換算する関数に、テストを足してください。' });
      started.push(oc.id ?? '');
      await c.sidebarItem(page, CODEX);
      await c.sidebarItem(page, OPENCODE);
      const rec = await c.record(page);
      await c.sleep(800);
      await (await c.sidebarItem(page, CLAUDE)).click();
      await c.sleep(1200);
      await (await c.sidebarItem(page, CODEX)).click({ modifiers: ['Alt'] });
      await c.sleep(1200);
      await (await c.sidebarItem(page, OPENCODE)).click({ modifiers: ['Alt'] });
      await c.sleep(1000);
      // 3 本の幅をそろえる（端末の行が折り返さないように）。
      const b0 = (await page.locator('.pane-divider').nth(0).boundingBox())!;
      const x0 = b0.x + b0.width / 2;
      const y0 = b0.y + b0.height / 2;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      await page.mouse.move(x0 - 150, y0, { steps: 20 });
      await page.mouse.up();
      await c.sleep(800);
      c.gate('agents-claude');
      await c.sleep(300);
      c.gate('agents-codex');
      await c.sleep(300);
      c.gate('agents-opencode');
      await c.until('agents の台本', c.transcriptHas('テストは 2 本とも通っています。'), 40_000);
      await c.sleep(4000);
      await rec.save('agents');
    } catch (err) {
      console.error('agents の失敗:', err);
      throw err;
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
      await close();
      for (const id of started) if (id) await api(c.e, 'DELETE', `/runs/${id}`).catch(() => {});
      await api(c.e, 'PATCH', '/settings', { codexEnabled: false, opencodeEnabled: false }).catch(() => {});
    }
  },
};
export default scene;
