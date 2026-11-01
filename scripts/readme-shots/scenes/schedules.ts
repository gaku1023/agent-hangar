// schedules：サイドバーの「予定」を開く → 新しい予定に指示を書き、平日の朝で作る → 行が一覧に入り、開く → 一時停止する。
import type { Scene } from '../kit.ts';

const PROMPT = '依存の脆弱性を点検して、直せるものは PR にして';

const scene: Scene = {
  name: 'schedules',
  kind: 'motion',
  watch: [
    'packages/ui/src/views/SchedulesScreen.tsx',
    'packages/ui/src/presenters/schedules.ts',
    'packages/server/src/schedule/*.ts',
    'packages/server/src/http/routes/schedules.ts',
  ],
  setup() {},
  async shoot(c) {
    const { page, close } = await c.openPage();
    const rec = await c.record(page);
    await c.sleep(800);
    await page.getByRole('link', { name: '予定' }).click();
    await c.sleep(1200);
    await page.getByRole('button', { name: '新しい予定' }).click();
    await c.sleep(900);
    await page.getByRole('textbox', { name: 'エージェントへの指示' }).pressSequentially(PROMPT, { delay: 70 });
    await c.sleep(900);
    await page.getByRole('button', { name: '作成', exact: true }).click();
    const title = page.getByRole('button', { name: PROMPT });
    await title.waitFor();
    await c.sleep(1400);
    await title.click();
    await c.sleep(1400);
    // 今すぐ実行：実物のサーバが会話を起こし、履歴に回が入る。
    await page.getByRole('button', { name: '今すぐ実行' }).click();
    await page.locator('.sch-runs .sch-run-name').first().waitFor({ timeout: 30_000 });
    await c.sleep(2500);
    await page.getByRole('switch').first().click();
    await c.sleep(1200);
    await rec.save('schedules');
    await close();
  },
};
export default scene;
