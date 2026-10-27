// todo：Claude が TODO を片付ける。TODO が 3 件ある → Claude が 1 件を「済んだ」と根拠つきで提案する → 利用者がチェックを入れる。
import { api } from '../env.ts';
import type { Scene } from '../kit.ts';

const PROJECT = 'recipe-notes';
const NAME = 'レシピの材料を人数分に換算する';
const TODOS = ['材料の分量を 2 人前から換算する関数を書く', '換算の結果を小数第 1 位で丸める', 'README に使い方の例を足す'];

const scene: Scene = {
  name: 'todo',
  kind: 'motion',
  setup(seed) {
    seed.project({ dir: PROJECT, name: PROJECT });
    seed.live('todo', {
      project: PROJECT,
      name: NAME,
      steps: [
        { gate: 'todo' },
        { user: '材料の分量を、人数に合わせて換算できるようにしてください。', intent: '材料の分量を人数に合わせて換算する関数を書き、テストで確かめる。' },
        { ms: 800, tool: 'Read', arg: 'src/scale.ts', input: { file_path: 'src/scale.ts' }, out: ['Read 38 lines'] },
        {
          ms: 700, tool: 'Update', arg: 'src/scale.ts',
          input: { file_path: 'src/scale.ts', old_string: 'export {};', new_string: 'export function scale(q: number, from: number, to: number) { return (q * to) / from; }' },
          summary: 'Updated src/scale.ts with 3 additions',
          diff: [[' ', 8, ''], ['+', 9, 'export function scale(q: number, from: number, to: number) {'], ['+', 10, '  return (q * to) / from;'], ['+', 11, '}']],
        },
        { ms: 800, tool: 'Bash', arg: 'npm test', input: { command: 'npm test' }, out: ['', '  ✓ scales 200 g from 2 to 3 servings (4 ms)', '  ✓ keeps the ratio for 0.5 cups (2 ms)', '', 'Tests: 2 passed, 2 total'], lineMs: 240 },
        { ms: 700, say: '分量の換算は scale() に入れて、テストも通りました。TODO の「換算する関数を書く」は済んだと提案しておきます。', final: true },
        { ms: 900, mcp: { tool: 'update_project', args: { propose_done: [{ todo_id: '@todo:換算する関数を書く', note: 'src/scale.ts に scale() を足し、テスト 2 本が通った。' }] } } },
      ],
    });
  },
  async shoot(c) {
    for (const text of TODOS) await api(c.e, 'POST', `/projects/${c.projectIds[PROJECT]}/todos`, { text });
    const { page, close } = await c.openPage();
    const rec = await c.record(page);
    await c.sleep(600);
    await page.getByText('プロジェクト', { exact: true }).first().click();
    await c.sleep(600);
    await page.locator('main').getByText(PROJECT, { exact: true }).first().click();
    await page.getByText(TODOS[0]!).first().waitFor();
    await c.sleep(1500);
    c.gate('todo');
    await c.until('todo の台本', c.transcriptHas('済んだと提案しておきます'), 40_000);
    await c.sleep(3000);
    await page.getByRole('checkbox').first().click();
    await c.sleep(2200);
    await rec.save('todo');
    await close();
  },
};
export default scene;
