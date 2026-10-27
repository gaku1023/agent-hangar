// wrap-up：終わったら片付く。Claude が仕事を終え、題と要約を書き、Done を提案する → 利用者が受ける → 一覧で Done の段に入る。
import type { Scene } from '../kit.ts';

const NAME = '週間予報に降水量の列を足す';
const PROJECT = 'weather-cli';

const scene: Scene = {
  name: 'wrap-up',
  kind: 'motion',
  watch: [
    'packages/ui/src/views/{SessionScreen,SummaryCard,ProjectScreen,PauseDialog,SessionList}.tsx',
    'packages/ui/src/presenters/{session,sessions,project,pause,live}.ts',
    'packages/ui/src/mediator/{live,sessionOrganize}.ts',
    'packages/server/src/summary/*.ts',
    'packages/server/src/sessions/{states,autoDone,notes}.ts',
    'packages/server/src/mcp/*.ts',
    'packages/server/src/http/routes/sessions.ts',
  ],
  setup(seed) {
    seed.live('wrap-up', {
      project: PROJECT,
      name: NAME,
      steps: [
        { gate: 'wrap-up' },
        { user: 'weather week の表に、1 日ごとの降水量（mm）の列を足してください。', intent: '週間予報の表に降水量（mm）の列を足す。まず表を作っている src/week.ts を読んでいる。' },
        { ms: 800, tool: 'Read', arg: 'src/week.ts', input: { file_path: 'src/week.ts' }, out: ['Read 61 lines'] },
        {
          ms: 700, tool: 'Update', arg: 'src/week.ts',
          input: { file_path: 'src/week.ts', old_string: 'pop: d.pop,', new_string: 'pop: d.pop,\n    rain: `${d.rainMm} mm`,' },
          summary: 'Updated src/week.ts with 1 addition',
          diff: [[' ', 23, '    pop: d.pop,'], ['+', 24, '    rain: `${d.rainMm} mm`,'], [' ', 25, '  }));']],
        },
        { ms: 800, tool: 'Bash', arg: 'npm test', input: { command: 'npm test' }, out: ['', '  ✓ week table has rain column (6 ms)', '  ✓ formats 0 mm (2 ms)', '', 'Tests: 2 passed, 2 total'], lineMs: 240 },
        { ms: 700, say: '週間予報の表に降水量の列を足しました。テストは 2 本とも通っています。要約を書いて、この会話を Done にすることを提案します。', final: true },
        {
          ms: 900,
          mcp: {
            tool: 'set_session_summary',
            args: {
              title: '週間予報に降水量の列を足す',
              one_liner: 'weather week の表に、1 日ごとの降水量（mm）の列を足した。',
              body: '- src/week.ts の表に rain 列を足した\n- 降水量が 0 のときも「0 mm」と出す\n- テスト 2 本を足して、すべて通った',
              state: 'done',
              next_steps: [],
            },
          },
        },
        { ms: 900, mcp: { tool: 'propose_session_status', args: { status: 'done', note: '降水量の列を足し、テストも通った。残りの作業は無い。' } } },
      ],
    });
  },
  async shoot(c) {
    const { page, close } = await c.openPage();
    const rec = await c.record(page);
    await c.sleep(600);
    await (await c.sidebarItem(page, NAME)).click();
    await c.sleep(1200);
    c.gate('wrap-up');
    await c.until('wrap-up の台本', c.transcriptHas('Done にすることを提案します'), 40_000);
    await c.sleep(3500);
    await page.locator('main').getByText('weather-cli').first().click();
    await c.sleep(1500);
    await page.getByText(/Done\s*[?？]/).first().click();
    await c.sleep(1800);
    await page.getByText('確定', { exact: true }).first().click();
    await c.sleep(2200);
    await page.getByRole('button', { name: /^Done 3/ }).or(page.getByText(/^Done\s*3$/)).first().click().catch(() => {});
    await c.sleep(1800);
    await rec.save('wrap-up');
    await close();
  },
};
export default scene;
