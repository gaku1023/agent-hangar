// usage：ヘッダの使用量のゲージを押して面を開く → Claude と Codex の窓ごとの残りが見える → 閉じる。
import type { Scene } from '../kit.ts';

const scene: Scene = {
  name: 'usage',
  kind: 'motion',
  watch: [
    'packages/ui/src/views/{AccountSwitcher,AccountSettings,UsageBar,CloudUsage}.tsx',
    'packages/ui/src/presenters/{accounts,cloudUsage}.ts',
    'packages/ui/src/mediator/accounts.ts',
    'packages/server/src/usage/*.ts',
    'packages/server/src/http/accounts.ts',
    'packages/server/src/http/routes/usage.ts',
  ],
  async shoot(c) {
    const { page, close } = await c.openPage();
    const rec = await c.record(page);
    await c.sleep(1200);
    await page.locator('button.account-switch').first().click();
    await page.getByRole('dialog').first().waitFor();
    await c.sleep(3200);
    await page.keyboard.press('Escape');
    await c.sleep(1200);
    await rec.save('usage');
    await close();
  },
};
export default scene;
