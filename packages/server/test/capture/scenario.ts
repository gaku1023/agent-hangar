/**
 * 見本を採るときの筋書き。採る道具（run.ts）と見本の試験（../claudeFixtures.test.ts）が同じものを読む。
 * 指示の文には JSON で書き換わる記号（引用符、バックスラッシュ）を入れない。採る道具が本文の中から文字列のまま探すためである。
 */
export const SCENARIO = {
  /** -n で付ける名前。レジストリの name と、トランスクリプトの題名になる。 */
  name: 'hangar-fixture',
  /** 1 つ目の指示。ファイルを書き、タスクの道具を使い、Bash で 20 秒待つ。待っている間に 2 つ目の指示を積む。 */
  first: 'Do these steps in order and keep every reply short. 1) Use your task list tool (TodoWrite or TaskCreate, whichever you have) to record two tasks: write notes.txt, then list the directory. 2) Use the Write tool to create notes.txt containing the single word hello. 3) Use the Bash tool to run exactly: sleep 20 && ls',
  /** 作業中に打って積む 2 つ目の指示。サブエージェントを使わせる。 */
  queued: 'Next, use the Agent tool to start one general-purpose subagent that runs ls with the Bash tool in this directory and reports how many entries it saw. Then reply with that number only.',
  /** 1 つ目の指示で書かせるファイル。 */
  file: 'notes.txt',
  /** 許す道具。--permission-mode dontAsk と組み合わせて、確認の画面で止まらないようにする。 */
  tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'],
} as const;

/** 置き換えの値。見本には、伏せた値の代わりにこれだけが残る。 */
export const PLACEHOLDER = {
  tmp: '/tmp/hangar-fixture',
  work: '/tmp/hangar-fixture/work',
  home: '/Users/me',
  /** 設定の置き場（CLAUDE_CONFIG_DIR か ~/.claude）。home と同じ /Users/me の下に置く。 */
  claudeDir: '/Users/me/.claude',
  host: 'fixture-host',
  /** Claude Code が uid ごとに使う一時の置き場の、置き換えの値。 */
  claudeTmp: '/tmp/claude-fixture',
  email: 'user@example.com',
  orgName: 'Example Org',
  orgId: '00000000-0000-4000-8000-000000000000',
  pidDomain: 'fixture',
  subscriptionType: 'max',
  costUsd: 0.01,
  /** 累計の時間（ミリ秒）。statusline の cost と、トランスクリプトの cost-state の行の時間を、これにする。 */
  durationMs: 1000,
  /** 窓ごとの使用率と戻る時刻（秒）。知らない窓は 1% と 1,800,000,000 秒にする。 */
  usedPercent: { five_hour: 12, seven_day: 3 } as Record<string, number>,
  resetsAtSec: { five_hour: 1_800_000_000, seven_day: 1_800_500_000 } as Record<string, number>,
} as const;
