// search：検索欄に「タグ」を 1 文字ずつ打つ → 一致が光る → 1 件を開く → 右欄のターンの目次で別のターンへ飛ぶ。
import type { Scene } from '../kit.ts';

const TITLE = 'タグ付けの設計を相談する';
const QUERY = 'タグ';

const scene: Scene = {
  name: 'search',
  kind: 'motion',
  setup(seed) {
    seed.past({
      project: 'photo-tagger',
      title: TITLE,
      minutesAgo: 60 * 3,
      state: 'done',
      turns: [
        ['写真のタグ付けを、どういう設計にすればよいか相談したいです。いまは文字列の配列です。', [
          ['Read', { file_path: 'src/tagger.ts' }, 'Read 84 lines'],
        ], 'タグを文字列の配列のまま持つ案と、種類（場所・季節・人物）を持つ案があります。検索のしやすさを考えると、種類つきがよさそうです。'],
        ['種類つきにすると、既存の写真のタグはどうなりますか。', [
          ['Grep', { pattern: 'tags' }, 'src/tagger.ts:12:  tags: string[]\nsrc/store.ts:40:  photo.tags'],
        ], '既存のタグは種類を「その他」にして移します。移行の処理は 1 回だけ走らせれば足ります。'],
        ['タグの一覧を種類ごとに出す画面も欲しいです。', [
          ['Write', { file_path: 'src/ui/TagList.ts', content: 'export function TagList() {}' }, 'File created successfully at: src/ui/TagList.ts'],
        ], '種類ごとに見出しを分けたタグの一覧を作りました。件数の多い順に並べています。'],
        ['タグを消したときに、写真から外れるか確かめてください。', [
          ['Bash', { command: 'npm test' }, 'Tests: 5 passed, 5 total'],
        ], 'タグを消すと、その写真からも外れることをテストで確かめました。5 本とも通っています。'],
      ],
    });
  },
  async shoot(c) {
    const { page, close } = await c.openPage();
    const rec = await c.record(page);
    await c.sleep(600);
    const box = page.getByPlaceholder('検索').first();
    await box.click();
    await c.sleep(400);
    await box.pressSequentially(QUERY, { delay: 450 });
    await c.sleep(500);
    await box.press('Enter');
    await page.getByText('名前に一致').first().waitFor();
    await c.sleep(1800);
    await page.getByText(TITLE).first().click();
    await page.locator('.turn-row').first().waitFor();
    await c.sleep(1600);
    await page.locator('.turn-row').nth(2).click();
    await c.sleep(2000);
    await page.locator('.turn-row').nth(1).click();
    await c.sleep(1800);
    await rec.save('search');
    await close();
  },
};
export default scene;
