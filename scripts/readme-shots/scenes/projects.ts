// projects：プロジェクト画面の静止画。
import type { Scene } from '../kit.ts';

const scene: Scene = {
  name: 'projects',
  kind: 'still',
  watch: [
    'packages/ui/src/views/{ProjectsScreen,ProjectScreen,ProjectInfo,TodoList,SessionList,EndedFacts,Pager}.tsx',
    'packages/ui/src/presenters/{projects,project,projectName,sessions,pager}.ts',
    'packages/ui/src/mediator/{projectList,projectRail,paging}.ts',
    'packages/server/src/projects/*.ts',
    'packages/server/src/http/routes/projects.ts',
  ],
  async shoot(c) {
    const { page, close } = await c.openPage();
    await page.getByText('プロジェクト', { exact: true }).first().click();
    await c.sleep(800);
    await page.locator('main').getByText('photo-tagger', { exact: true }).first().click();
    await page.getByText('RAW 画像の読み込み').first().waitFor();
    await c.sleep(1200);
    await c.screenshot(page, 'projects');
    await close();
  },
};
export default scene;
