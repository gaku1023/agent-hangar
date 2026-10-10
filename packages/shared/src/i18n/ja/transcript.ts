import type { transcriptKeys } from '../keys/transcript.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const transcriptJa: AreaDictionary<typeof transcriptKeys> = {
  'transcript.diff.gap': '⋯ {n} 行 ⋯',
  'transcript.bash.exitCode': '終了コード {code}',
  'transcript.bash.failed': '失敗',
  'transcript.bash.noResult': '結果なし',
  'transcript.bash.noOutput': '出力なし',
  'transcript.bash.lines': '{n} 行',
  'transcript.fetch.prompt': '聞いたこと',
  'transcript.search.results': '結果 {n} 件',
  'transcript.tool.hits': '一致 {n}',
  'transcript.tool.result': '結果',
  'transcript.tool.raw': '詳細表示',
  'transcript.tool.viewSubagent': 'サブエージェント {id} を見る',
  'transcript.find.noMatch': '0 件',
  'transcript.find.label': 'トランスクリプト内を検索',
  'transcript.find.matchCase': '大文字と小文字を区別',
  'transcript.find.prev': '前の一致（{keys}）',
  'transcript.find.next': '次の一致（{keys}）',
  'transcript.find.close': '閉じる（esc）',
  'transcript.empty.none': 'トランスクリプトがありません',
  'transcript.more.older': '古い行を読み込む（残り {n} 件）',
  'transcript.more.newer': '新しい行を読み込む',
  'transcript.more.unseen': '新着 {n} 件',
};
