// README の画像に写す見本のデータ。名前も中身も架空である。
// 共通の土台（プロジェクト 3 つと過去の会話）。場面が足す分は scenes/<名前>.ts の setup(seed) で足す。
// 生きた会話の台本は各場面の seed.live() で登録する。

export const PROJECTS = [
  { dir: 'photo-tagger', name: 'photo-tagger' },
  { dir: 'blog-engine', name: 'blog-engine' },
  { dir: 'weather-cli', name: 'weather-cli' },
];

/**
 * 過去の会話。minutesAgo は最後の発言からの経過。
 * state は Active / Paused / Done の印（null は印なし）。note は Paused の理由。
 * turns は [ユーザーの発言, [ツールの呼び出し...], 返答] の並び。ツールは [名前, 入力, 結果]。
 */
export const PAST = [
  // photo-tagger
  {
    project: 'photo-tagger', title: 'タグの重複を除く', minutesAgo: 60 * 26, state: 'done',
    turns: [
      ['同じ写真に同じタグが二重に付くことがあります。原因を調べて直してください。', [
        ['Grep', { pattern: 'addTag' }, 'src/tagger.ts:41:  addTag(photo, tag)\nsrc/cli.ts:18:  addTag(p, t)'],
        ['Edit', { file_path: 'src/tagger.ts', old_string: 'photo.tags.push(tag)', new_string: 'if (!photo.tags.includes(tag)) photo.tags.push(tag)' }, 'The file src/tagger.ts has been updated.'],
      ], 'addTag が既に付いているタグも追加していました。重複を見てから追加するようにして、テストを 1 本足しました。'],
    ],
  },
  {
    project: 'photo-tagger', title: 'サムネイルの生成を速くする', minutesAgo: 60 * 24 * 3, state: 'paused', note: '大きな RAW の計測が終わってから続ける',
    turns: [
      ['サムネイルの生成が遅いです。どこで時間がかかっているか計測してください。', [
        ['Bash', { command: 'node scripts/bench-thumbs.mjs' }, 'resize: 412ms\nencode: 96ms\nread: 31ms'],
      ], '時間の大半はリサイズです。sharp の設定を変えて、もう一度計測します。RAW は別の経路なので後回しにしました。'],
    ],
  },
  {
    project: 'photo-tagger', title: '日本語のタグ名を許す', minutesAgo: 60 * 24 * 5, state: 'done',
    turns: [
      ['タグ名に日本語を使えるようにしたいです。', [
        ['Read', { file_path: 'src/validate.ts' }, 'Read 52 lines'],
        ['Edit', { file_path: 'src/validate.ts', old_string: '/^[a-z0-9-]+$/', new_string: '/^[\\p{L}\\p{N}-]+$/u' }, 'The file src/validate.ts has been updated.'],
      ], '正規表現を Unicode の文字と数字に広げました。空白と記号は引き続き断ります。'],
    ],
  },
  {
    project: 'photo-tagger', title: 'READMEに使い方を足す', minutesAgo: 60 * 24 * 9, state: 'done',
    turns: [['README に、タグの付け方の例を足してください。', [['Edit', { file_path: 'README.md', old_string: '## 使い方', new_string: '## 使い方\n\n```\nphoto-tagger add ./photos --tag 旅行\n```' }, 'The file README.md has been updated.']], '使い方の節に、フォルダ全体へタグを付ける例を足しました。']],
  },
  {
    project: 'photo-tagger', title: 'RAW 画像の読み込み', minutesAgo: 60 * 24 * 2, state: 'paused', note: '対応する RAW の形式を決めてから',
    turns: [['RAW 画像も読めるようにしたいです。どの形式から始めるのがよいですか。', [['Read', { file_path: 'src/meta.ts' }, 'Read 40 lines']], '多くの機種で使われている DNG から始める案です。形式ごとの違いを表にまとめました。']],
  },
  {
    project: 'photo-tagger', title: 'エラー表示を分かりやすく', minutesAgo: 60 * 20, state: null,
    turns: [['壊れた画像のときのエラーが分かりにくいです。', [['Edit', { file_path: 'src/cli.ts', old_string: 'throw e', new_string: 'console.error(`読めない画像: ${file}`)' }, 'The file src/cli.ts has been updated.']], '壊れた画像はファイル名つきで知らせて、残りの処理を続けるようにしました。']],
  },
  // blog-engine
  {
    project: 'blog-engine', title: 'RSS の日付の形式を直す', minutesAgo: 60 * 5, state: 'paused', note: '読み手の側の確認待ち',
    turns: [
      ['RSS の pubDate が RFC 822 になっていないと言われました。', [
        ['Grep', { pattern: 'pubDate' }, 'src/feed.ts:27:  <pubDate>${post.date.toISOString()}</pubDate>'],
        ['Edit', { file_path: 'src/feed.ts', old_string: 'post.date.toISOString()', new_string: 'post.date.toUTCString()' }, 'The file src/feed.ts has been updated.'],
      ], 'toISOString を toUTCString に変えました。RFC 822 の形で出ます。フィードの検証サイトでの確認は、お手元でお願いします。'],
    ],
  },
  {
    project: 'blog-engine', title: '記事のタグ一覧ページ', minutesAgo: 60 * 24 * 2, state: 'done',
    turns: [['タグごとの記事一覧ページを作ってください。', [['Write', { file_path: 'src/pages/tags.ts', content: 'export function tagPage() {}' }, 'File created successfully at: src/pages/tags.ts']], '/tags/<名前> に記事の一覧を出すページを足しました。タグが無い記事は一覧に出しません。']],
  },
  {
    project: 'blog-engine', title: 'Markdown の脚注に対応', minutesAgo: 60 * 24 * 4, state: 'done',
    turns: [['Markdown の脚注 [^1] を表示できるようにしたいです。', [['Bash', { command: 'npm i markdown-it-footnote' }, 'added 1 package']], 'markdown-it-footnote を入れて、記事の末尾に脚注を並べるようにしました。']],
  },
  {
    project: 'blog-engine', title: '画像の遅延読み込み', minutesAgo: 60 * 24 * 8, state: null,
    turns: [['記事の画像を遅延読み込みにしたいです。', [['Edit', { file_path: 'src/render.ts', old_string: '<img src', new_string: '<img loading="lazy" src' }, 'The file src/render.ts has been updated.']], 'img に loading="lazy" を付けました。先頭の画像だけは eager のままにしてあります。']],
  },
  // weather-cli
  {
    project: 'weather-cli', title: '週間予報の表示', minutesAgo: 60 * 8, state: 'done',
    turns: [['weather week で 7 日分を表にして出してください。', [['Edit', { file_path: 'src/week.ts', old_string: 'console.log(days)', new_string: 'console.table(days)' }, 'The file src/week.ts has been updated.']], '7 日分を console.table で出すようにしました。最高と最低の気温、降水確率の列があります。']],
  },
  {
    project: 'weather-cli', title: '摂氏と華氏の切り替え', minutesAgo: 60 * 24 * 2, state: 'paused', note: '設定ファイルの形を決めてから',
    turns: [['--unit F で華氏にできるようにしたいです。設定ファイルでも決められると嬉しいです。', [['Read', { file_path: 'src/args.ts' }, 'Read 37 lines']], 'コマンドの引数は対応できます。設定ファイルの形を先に決めたいので、案を 2 つ書きました。']],
  },
  {
    project: 'weather-cli', title: 'API 呼び出しのリトライ', minutesAgo: 60 * 24 * 6, state: 'done',
    turns: [['天気 API が時々 503 を返します。リトライを入れてください。', [['Edit', { file_path: 'src/api.ts', old_string: 'await fetch(url)', new_string: 'await retry(() => fetch(url), { times: 3 })' }, 'The file src/api.ts has been updated.']], '最大 3 回、間隔を空けて再試行します。404 は再試行しません。']],
  },
];
