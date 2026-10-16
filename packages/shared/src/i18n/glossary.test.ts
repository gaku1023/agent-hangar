import { describe, expect, it } from 'vitest';
import { en } from './en.ts';
import { ja } from './ja.ts';

/**
 * 用語集（docs/superpowers/specs/2026-10-09-glossary.md の 13 章「使わない語」）のうち、機械で見張れるものを守らせる。
 * 辞書の文に、決めた語の代わりに古い語が残っていたら止める。
 */
const FORBIDDEN_JA: Array<{ pattern: RegExp; use: string }> = [
  { pattern: /会話の記録|生の記録/, use: 'トランスクリプト、詳細表示' },
  { pattern: /控え(?!る)|控えて/, use: 'バックアップ' },
  { pattern: /引き取/, use: 'hangar に移動' },
  { pattern: /(?<!い)ずれ|差異/, use: '変更点' },
  { pattern: /契約/, use: '確認項目' },
  { pattern: /確かめ/, use: '確認する' },
  { pattern: /(?<!一時的に)止め/, use: '無効にする、停止する、一時停止' },
  { pattern: /休み|休ん|待機/, use: 'アイドル、入力待ち' },
  { pattern: /つなぎ|つなぐ|つなが/, use: '接続、再接続' },
  { pattern: /作り直|読み直/, use: '再構築、再生成、再読み込み' },
  { pattern: /外のターミナル|別のターミナル/, use: '外部ターミナル' },
  { pattern: /スクラッチ/, use: 'クイックセッション' },
  { pattern: /ワークスペース/, use: 'プロジェクトの親ディレクトリ' },
  { pattern: /要約器/, use: '要約エンジン' },
  { pattern: /成果物/, use: 'アーティファクト' },
  { pattern: /費用/, use: 'コスト、料金、請求額' },
  { pattern: /右の欄|右レール/, use: '右パネル' },
  { pattern: /キーの一覧/, use: 'キーボードショートカット' },
  { pattern: /新規セッション|ここで新規/, use: '新しいセッション、ここで開始' },
  { pattern: /メモ(?!リ)/, use: 'ノート、メモリ' },
  { pattern: /指揮役|主線/, use: 'メイン会話' },
  { pattern: /戻る日|戻る時刻|戻る時点|今日戻る|再開予定/, use: 'リマインダー' },
  { pattern: /利用上限|セッション制限|(?:5 時間|週の)枠/, use: '使用制限、5 時間、週' },
  { pattern: /(?<!\/)statusline/, use: 'ステータスライン' },
  { pattern: /手元の版/, use: 'インストール済みのバージョン' },
  { pattern: /取り込/, use: '適用' },
  { pattern: /バックグラウンドのセッション/, use: 'バックグラウンドセッション' },
  { pattern: /動いて(?:い|お)/, use: '実行中' },
  { pattern: /やりかけ|詰まっ|やめた/, use: '進行中、ブロック中、中止' },
  { pattern: /(?<!折り)畳む/, use: '折りたたむ' },
  { pattern: /最新へ戻/, use: '最新へ移動' },
  { pattern: /写し/, use: 'コピー' },
  { pattern: /外す|外し|外せ/, use: '解除する' },
  { pattern: /日を変える|名前を変える|色を変える/, use: '日付を変更、名前を変更、色を変更' },
  { pattern: /やり終え|いま進めている|一覧の奥/, use: '札の説明（完了したもの、進行中のもの、一覧に表示しないもの）' },
  { pattern: /(?:を|で)探す/, use: '検索' },
  { pattern: /手目/, use: 'ツール呼び出し' },
  { pattern: /降ろせ/, use: '取得できなかった' },
  { pattern: /入れてください|入れ直/, use: '入力、インストール、オンにする' },
  // 2026-10-16 の文言の見直し（用語集 14 章）。ふつうの UI 語と開発者の語にそろえる。
  { pattern: /足(?:す|し|さ)/, use: '追加する' },
  { pattern: /やめる/, use: 'キャンセル' },
  { pattern: /(?<![必重主概])要(?:る|ら|り)/, use: '必要、不要' },
  { pattern: /(?:^|[、。「（\s])いま/, use: '省く、現在' },
  { pattern: /場所|置き場/, use: 'ディレクトリ、パス、保存先、所在地' },
  { pattern: /フォルダ/, use: 'ディレクトリ' },
  { pattern: /(?<!暗号)鍵/, use: 'キー' },
  { pattern: /秘密/, use: 'シークレット、参加トークン' },
  { pattern: /道具/, use: 'ツール' },
  { pattern: /持ち主/, use: '所有者' },
  { pattern: /手元|相手/, use: 'この PC、他の PC' },
  { pattern: /読むだけ/, use: '読み取り専用' },
  { pattern: /索引/, use: 'インデックス' },
  { pattern: /既定/, use: 'デフォルト' },
  { pattern: /利用者/, use: 'ユーザー' },
  { pattern: /命令/, use: 'コマンド' },
  { pattern: /押(?:す|せ|し|さ)/, use: 'クリック、使える' },
  { pattern: /降ろ/, use: 'ダウンロード' },
  { pattern: /困って|代わりの案|直し方の案/, use: '課題、代替案、修正案' },
  { pattern: /最後の活動|審査|聞いたこと/, use: '最終アクティビティ、レビュー、プロンプト' },
  { pattern: /\} 本/, use: '{n} 件' },
  // 2026-10-17 の文言の洗い直し（用語集 18 章）。造語と擬人化、揺れを見張る。
  { pattern: /届(?:い|く)/, use: '受信する' },
  { pattern: /らしい/, use: 'と思われる' },
  { pattern: /延ばす/, use: '延長' },
  { pattern: /新しい版/, use: '新しいバージョン' },
  { pattern: /1 つにまとめる/, use: '統合' },
  { pattern: /端末(?!トークン)/, use: 'PC' },
  { pattern: /に出ています|と出ます|を出します/, use: '表示されています、表示します' },
  { pattern: /残(?:ります|します|るため|るもの)|に残し/, use: '保存する、保持する、削除されません' },
  { pattern: /指示書/, use: '適用内容' },
  { pattern: /サーバ(?!ー)/, use: 'サーバー' },
  { pattern: /ほかの/, use: '他の' },
  { pattern: /昇格/, use: 'プロジェクトにする' },
  { pattern: /入力を受け付けている/, use: '入力可能' },
];

/** 古い語に見えても、用語集が別の意味で認める場所。鍵ごとに理由を添えて、ここだけ外す。 */
const ALLOWED: Record<string, string> = {
  // サーバのポートの話で、セッションの状態ではない。
  'settings.integrations.statusline.port': '動いている（サーバのプロセス）',
  // Claude に頼む指示の文で、検索の操作ではなく「誤りを見つける」の意味。
  'prompt.builtin.codeReview': '探す（誤りを見つける）',
  // Claude に渡す指示の文で、画面には出ない。起動の指示は別の作業が直すため、ここでは外す（2026-10-17）。
  'launch.injection.handover': 'らしい（Claude 向けの指示）',
};

/** 「本文」が HTTP やモデルの応答の本体（body）を指す鍵。トランスクリプトの意味では使わない。 */
const BODY_KEYS = /^(http\.request\.|todo\.error\.emptyText$|summary\.lmstudio\.)/;

const entries = (dict: Record<string, string>): Array<[string, string]> => Object.entries(dict);

describe('辞書は用語集の語に合っている', () => {
  it('日本語の文に、使わない語が残っていない', () => {
    const bad: string[] = [];
    for (const [key, text] of entries(ja as Record<string, string>)) {
      if (key in ALLOWED) continue;
      for (const f of FORBIDDEN_JA) if (f.pattern.test(text)) bad.push(`${key}: ${f.pattern} は ${f.use}`);
      if (text.includes('本文') && !BODY_KEYS.test(key)) bad.push(`${key}: 本文 は トランスクリプト`);
    }
    expect(bad).toEqual([]);
  });

  it('英語の文に、会話の記録の意味の conversation record が残っていない', () => {
    const bad = entries(en as Record<string, string>).filter(([, text]) => /conversation record/i.test(text)).map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it('英語の文に、使わない語が残っていない', () => {
    const FORBIDDEN_EN: Array<{ pattern: RegExp; use: string }> = [
      { pattern: /take over|taking over|taken over/i, use: 'Move to Hangar' },
      { pattern: /\bdifferences?\b/i, use: 'change' },
      { pattern: /outside terminal/i, use: 'external terminal' },
      { pattern: /Under 1 min/, use: '<1 min' },
    ];
    const bad: string[] = [];
    for (const [key, text] of entries(en as Record<string, string>)) {
      for (const f of FORBIDDEN_EN) if (f.pattern.test(text)) bad.push(`${key}: ${f.pattern} は ${f.use}`);
    }
    expect(bad).toEqual([]);
  });
});
