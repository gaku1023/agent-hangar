# README 用の画像を撮る台本

```
npm run readme-shots                       # 全部撮る
npm run readme-shots -- --only hero,search # 場面を選ぶ
npm run readme-shots -- --only mine --solo # その場面だけを読み、ほかの場面の setup も走らせない（試し撮り用）
npm run readme-shots -- --hold             # 撮らずに画面を開いたまま止める（画面の確かめ用）
npm run readme-shots -- --keep             # 一時ディレクトリを残す
```

前提は `npm run build` 済み、`tmux`・`ffmpeg`・`img2webp`（`brew install tmux ffmpeg webp`）。
node が PATH に無いときは `mise exec -- npm run readme-shots` のように前に付ける。
出力は `docs/images/`。motion は `<名前>.webp`（15fps、幅 1600px 前後、3MB 以下を目安に自動で画質を下げる）、still は `<名前>.png`（DPR 2）。

## 場面の足し方

`scenes/<名前>.ts` を 1 本置くだけでよい。run.ts、env.ts、data.mjs、fake-claude.mjs、stage.ts、recorder.ts は触らない。
`name` はファイル名と同じにする。`_` か `.` で始まる、または名前に `.` を含むファイル（`hero.script.mjs` など）は場面として読まれない。台本を別ファイルに切るときに使う。
型は `kit.ts`。

```ts
import type { Scene } from '../kit.ts';

const scene: Scene = {
  name: 'mine',
  kind: 'motion',                       // 'motion' は webp、'still' は png
  setup(seed) {                         // 見本のデータの追加。全場面の setup が毎回走る
    seed.past({ project: 'photo-tagger', title: '…', minutesAgo: 90, state: 'done', turns: [['発言', [], '返答']] });
    seed.live('mine', { project: 'photo-tagger', name: '会話の名前', steps: [{ gate: 'mine' }, { user: '…' }, { say: '…', final: true }] });
  },
  async shoot(c) {
    const { page, close } = await c.openPage();
    const rec = await c.record(page);   // コマを集め始める
    await c.sidebarItem(page, '会話の名前').then((l) => l.click());
    c.gate('mine');                     // 台本の { gate: 'mine' } の行を開ける
    await rec.save('mine');             // docs/images/mine.webp。最後のコマで 1.5 秒止まる
    await close();
  },
};
export default scene;
```

静止画は `c.screenshot(page, '名前')`。

## 差し込み口

| 口 | 使い方 |
| --- | --- |
| `seed.project({ dir, name })` | 見本のプロジェクトを足す。`dir` はワークスペース直下のフォルダ名 |
| `seed.past({...})` | 過去の会話を足す。`title` は全場面で重ならない名前にする。`turns` は `[発言, [[ツール名, 入力, 結果]], 返答]` の並び。複数ターンにできる |
| `seed.live(key, { project, name, steps })` | 偽の claude が台本どおりに流す生きた会話。`name` は全場面で重ならない名前にする。`steps` の形は `kit.ts` の `LiveStep`。`{ gate }` の行はそこで止まり、`shoot` の `c.gate(名前)` で進む。`ctx.live[key]` が会話の id |
| `seed.mock({ match, json })` | 全場面のページで API の応答を差し替える。`match` は `'/api/usage'` のような pathname、正規表現、関数。`json` は値か、要求を受けて返す関数 |
| `mocks.ts` の `MOCKS` | 同じ差し替えを共通で置く場所。使用量の担当が `/api/usage` の見本を足す（右上の「メイン 未取得」を埋める） |
| `c.openPage({ mocks, init, prepare })` | この場面のページだけ API を差し替える、ページが開く前に走らせる JS（localStorage など）、ホームが出た後の用意。画面は 1280×800・DPR 2 で固定（DPR は起動の引数で決める。context の deviceScaleFactor にすると端末の文字が倍になる） |
| `c.live` / `c.projectIds` / `c.pastIds` | 登録した会話・プロジェクトの id（過去の会話は title から） |
| `c.sleep` / `c.until` / `c.transcriptHas(text)` / `c.sidebarItem(page, text)` | 待ちと、サイドバーの項目の取得 |

## 決まり

- 画面に出るのは架空の名前と `/Users/demo` だけ。一時ディレクトリの名前は stage.ts が `/Users/demo` に読み替える。
- 見本のデータは名前も中身も架空にする。実在の人名・会社名・実際のデータを書かない。
- 台本の時間は fake-claude.mjs が 0.6 倍に詰める。
- 利用者の実データと 4177 のサーバには触らない。自分が起こしたサーバと、専用ソケットの tmux だけを止める。
