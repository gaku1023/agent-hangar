/**
 * 外のターミナルの codex（シェルの包みの codex()、docs/design.md「外のターミナルの codex」）が使う一覧。
 * codex 0.164.0 の `codex --help` の Commands と Options から作った。
 */

/**
 * 包まずにそのまま渡すサブコマンド。別名（e、a）も入れる。
 * resume は ID が 1 つのときだけ hangar の起動へ写すので、ここには入れない。fork は hangar の入口が別なので、ここでは素通しにする。
 */
export const BUILTIN_CODEX_SUBCOMMANDS: readonly string[] = [
  'a', 'agents', 'app', 'app-server', 'apply', 'archive', 'cloud', 'completion', 'debug', 'delete', 'doctor',
  'e', 'exec', 'exec-server', 'features', 'fork', 'help', 'login', 'logout', 'mcp', 'migrate-nfs-db', 'migrate-rollouts',
  'plugin', 'queue', 'remote-control', 'review', 'sandbox', 'unarchive', 'update',
];

/** 横取りして hangar の起動へ写すフラグ。ほかのフラグが 1 つでもあれば包まずに渡す（許可リスト方式）。どれも値を取る。 */
export const CODEX_INTERCEPT_FLAGS: readonly string[] = ['--ask-for-approval', '--config', '--model', '--sandbox', '-a', '-c', '-m', '-s'];

/** 会話の ID の形（UUID）。resume の引数がこの形のときだけ hangar に頼む。名前や --last は codex の選ぶ画面や探し方に任せる。 */
export const CODEX_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
