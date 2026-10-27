// new-session：ヘッダの「新しいセッション」→ プロジェクトを選ぶ → エージェントの札を見せて選ぶ → 初期プロンプトで / と @ の候補 → 起動 → 端末が流れ出す。
// Codex と opencode の札は設定の「連携」を有効にしたときだけ出る。偽物（agents.fakes.ts）を置いて有効にし、撮り終えたら無効に戻す。
import fs from 'node:fs';
import path from 'node:path';
import type { Scene } from '../kit.ts';
import { api } from '../env.ts';
import { installAgentFakes } from './agents.fakes.ts';

const PROJECT = 'pocket-notes';
const SKILLS: [string, string][] = [
  ['changelog', '直近の変更から、変更履歴の下書きを作る'],
  ['release-notes', 'リリースノートを日本語で書く'],
];

const scene: Scene = {
  name: 'new-session',
  kind: 'motion',
  watch: [
    'packages/ui/src/views/{NewSessionDialog,ModelPicker,LaunchChips,LaunchPrepBox,ParentField,FolderBrowse,AgentIcon}.tsx',
    'packages/ui/src/presenters/{newSession,codexLaunch,modelPicker,launchPrep,agentIcon}.ts',
    'packages/ui/src/mediator/{launch,launchPrep}.ts',
    'packages/server/src/launch/*.ts',
    'packages/server/src/prompt/*.ts',
    'packages/server/src/http/routes/{runs,prompt}.ts',
  ],
  setup(seed) {
    seed.project({ dir: PROJECT, name: PROJECT });
  },
  async shoot(c) {
    const { e } = c;
    // 見本のファイルとスキル。@ と / の候補に出る。
    const cwd = e.cwdOf[PROJECT]!;
    for (const [f, body] of [['notes.ts', 'export const notes = [];\n'], ['search.ts', 'export function search() {}\n'], ['storage.ts', 'export function save() {}\n']] as const) {
      fs.writeFileSync(path.join(cwd, 'src', f), body);
    }
    for (const [n, d] of SKILLS) {
      const dir = path.join(e.claudeDir, 'skills', n);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${n}\ndescription: ${d}\n---\n`);
    }
    installAgentFakes(e, { codex: [], opencode: [] });
    await api(e, 'PATCH', '/settings', { codexEnabled: true, opencodeEnabled: true });
    type Runs = { runs: { id: string; sessionId?: string }[] };
    const before = new Set((await api<Runs>(e, 'GET', '/runs')).runs.map((r) => r.id));
    const { page, close } = await c.openPage();
    try {
      const rec = await c.record(page);
      await c.sleep(700);
      await page.getByRole('button', { name: /新しいセッション/ }).first().click();
      const dialog = page.locator('.dialog-new-session');
      await dialog.waitFor();
      await c.sleep(900);

      // プロジェクトを選ぶ。
      await dialog.locator('#new-session-project').click();
      await c.sleep(900);
      await page.locator('[role="option"]').filter({ hasText: PROJECT }).first().click();
      await c.sleep(800);

      // エージェントの札。3 つ並ぶところを見せて、Claude Code を選ぶ。
      await dialog.getByText('Claude Code').first().click();
      await c.sleep(900);
      await page.locator('[role="option"]').filter({ hasText: 'Codex' }).first().hover();
      await c.sleep(700);
      await page.locator('[role="option"]').filter({ hasText: 'opencode' }).first().hover();
      await c.sleep(700);
      await page.locator('[role="option"]').filter({ hasText: 'Claude Code' }).first().click();
      await c.sleep(800);

      // 初期プロンプト。/ でスキルとコマンド、@ でファイルの候補。
      const box = dialog.locator('textarea').first();
      await box.click();
      await c.sleep(400);
      await box.pressSequentially('/', { delay: 200 });
      await c.sleep(1500);
      await box.pressSequentially('rev', { delay: 300 });
      await c.sleep(1100);
      await box.press('Enter');
      await c.sleep(500);
      await box.pressSequentially('@', { delay: 200 });
      await c.sleep(1500);
      await box.pressSequentially('no', { delay: 300 });
      await c.sleep(1200);
      await box.press('Enter');
      await c.sleep(400);
      await box.pressSequentially('の変更に、抜けがないか見てください。', { delay: 70 });
      await c.sleep(900);

      // 台本は、入った本文そのもので選ぶ（偽の claude が起動の引数の末尾から読む）。
      const prompt = (await box.inputValue()).trim();
      fs.writeFileSync(path.join(e.root, 'by-prompt.json'), JSON.stringify([{
        prompt,
        steps: [
          { gate: 'new-session' },
          { user: prompt, intent: 'notes.ts の直近の変更を見て、抜けがないかを確かめる。まずファイルを読んでいる。' },
          { ms: 700, say: 'notes.ts と、それを使っている search.ts を読みます。' },
          { ms: 700, tool: 'Read', arg: 'src/notes.ts', input: { file_path: 'src/notes.ts' }, out: ['Read 38 lines'] },
          { ms: 600, tool: 'Grep', arg: 'notes', input: { pattern: 'notes' }, out: ['src/search.ts:3:  import { notes } from "./notes"', 'src/storage.ts:7:  save(notes)'] },
          { ms: 800, tool: 'Bash', arg: 'npm test', input: { command: 'npm test' }, out: ['', '  ✓ saves a note (5 ms)', '  ✓ finds a note by word (3 ms)', '', 'Tests: 2 passed, 2 total'], lineMs: 260 },
          { ms: 800, say: '大きな抜けはありません。空のメモを保存したときの扱いだけ、テストを足すとよさそうです。', final: true },
        ],
      }]));

      await dialog.locator('.btn-primary').first().click();
      await page.locator('.xterm').first().waitFor();
      await c.sleep(1800);
      c.gate('new-session');
      await c.until('new-session の台本', c.transcriptHas('空のメモを保存したときの扱い'), 40_000);
      await c.sleep(2200);
      await rec.save('new-session');
    } catch (err) {
      console.error('new-session の失敗:', err);
      throw err;
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
      await close();
      // 起こしたセッションを止めて消す。後の場面のサイドバーに残さない。
      const runs = (await api<Runs>(e, 'GET', '/runs').catch(() => ({ runs: [] }))).runs;
      for (const r of runs) {
        if (before.has(r.id)) continue;
        await api(e, 'DELETE', `/runs/${r.id}`).catch(() => {});
        await api(e, 'DELETE', `/sessions/${r.sessionId ?? r.id}`).catch(() => {});
      }
      await api(e, 'PATCH', '/settings', { codexEnabled: false, opencodeEnabled: false }).catch(() => {});
    }
  },
};
export default scene;
