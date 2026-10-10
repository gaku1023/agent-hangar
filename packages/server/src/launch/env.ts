import { CLAUDE_CHILD_ENV } from '../provider/claude-code/compat/childEnv.ts';

// hangar が起こすものへ持ち込まない環境変数。
// 殻やターミナルから受け継いだ環境は、サーバ、tmux サーバ、claude の run、シェルのタブへ順に流れていく。
// 途中の段で外さないと、Claude Code のセッションの印や、hangar の部品のあいだの受け渡しの値が、関係の無い claude まで届く。

/**
 * hangar の部品のあいだで受け渡す変数。殻と `hangar start` がサーバに渡し、サーバは起動のときに 1 度だけ読む。
 * claude の中では誰も読まない。残すと、claude の Bash で起こした試しのサーバ（npm run dev や tsx main.ts）が、
 * アプリのポートで待とうとし、アプリの殻を親と見て見張り、アプリの UI を配る。
 * HANGAR_PORT もここに入れる。statusline の台本はポートを書き込み時に埋め、MCP の設定はファイルに URL を持ち、
 * hangar の CLI は --port（既定 4177）で決めるので、claude の中で HANGAR_PORT を読むものは無い。
 * HANGAR_STOP_ON_STDIN_END は Windows の殻が立てる。標準入力が閉じたら止める合図にせよ、という意味である（entry.ts の runMain）。
 * 残すと、claude の中で起こした試しのサーバが、標準入力の閉じで勝手に降りる。
 * HANGAR_LAUNCHER も Windows の殻が立てる。外のアプリをジョブの外で起こす起こし役（殻の実行ファイル）の場所である（external/breakaway.ts）。
 * 残すと、claude の中で起こした試しのサーバが、ジョブに入っていないのに殻を起こし役に使う。
 */
const HANGAR_HANDOFF_ENV = ['HANGAR_PARENT_PID', 'HANGAR_PORT', 'HANGAR_UI_DIST', 'HANGAR_STOP_ON_STDIN_END', 'HANGAR_LAUNCHER'];

/**
 * サーバが読まない hangar の変数。
 * HANGAR_RUN_ID は hangar の claude の中で立つ印で、そこから起こされたサーバには関係が無い。
 * HANGAR_UNSET_ENV は Windows の包みへの合図である。
 * HANGAR_CLOUD_DIR は CLI の開発用の上書きで、継いだ claude の中の `hangar setup cloud` が止まっていた。
 */
const HANGAR_STRAY_ENV = ['HANGAR_RUN_ID', 'HANGAR_UNSET_ENV', 'HANGAR_CLOUD_DIR'];

/**
 * サーバが起動の最初に自分の環境から消す名前。殻もサーバを起こすときに外す（server.rs の INHERITED_ENV_DROPPED）。
 * 消しておけば、サーバが起こす tmux サーバの全体の環境にも、サーバが直に起こす claude（--help、agents、-p の要約、auth status）にも残らない。
 * HANGAR_HOME、HANGAR_CLAUDE_DIR、HANGAR_CLAUDE_BIN、HANGAR_DEV は、サーバが動いている間ずっと読むので消さない。
 */
export const SERVER_DROPPED_ENV: readonly string[] = [...CLAUDE_CHILD_ENV, ...HANGAR_HANDOFF_ENV, ...HANGAR_STRAY_ENV];

/**
 * claude の run とシェルのタブに渡さない名前。tmux サーバの全体の環境がすでに汚れていても外れるよう、起こすたびに外す。
 * HANGAR_HOME は渡す。statusline の台本（`${HANGAR_HOME:-$HOME/.agent-hangar}`）と hangar の CLI が、claude の中で置き場を知るのに読む。
 * HANGAR_RUN_ID は run ごとに立て直す。HANGAR_UNSET_ENV は Windows の包みが自分で読んで消すので、ここに入れると包みに届かない。
 * CLAUDE_CONFIG_DIR は利用者の設定なので入れない。アカウントの置き場で決まるので、外すかどうかは呼び手が決める。
 */
export const RUN_DROPPED_ENV: readonly string[] = [...CLAUDE_CHILD_ENV, ...HANGAR_HANDOFF_ENV, 'HANGAR_CLOUD_DIR'];

/** サーバが起動のときに受け取る値。 */
export type ServerHandoff = { port: number | undefined; parentPid: number | undefined; uiDist: string | undefined; stopOnStdinEnd: boolean; launcher: string | undefined };

/**
 * 受け渡しの値を読んでから、SERVER_DROPPED_ENV を env から消す。サーバの入口（main.ts）が、ほかの何よりも先に呼ぶ。
 * 空の値は渡されていないものとして扱う。
 */
export function takeServerEnv(env: NodeJS.ProcessEnv = process.env): ServerHandoff {
  const port = env.HANGAR_PORT ? Number(env.HANGAR_PORT) : undefined;
  const parentPid = env.HANGAR_PARENT_PID ? Number(env.HANGAR_PARENT_PID) : undefined;
  const uiDist = env.HANGAR_UI_DIST || undefined;
  const stopOnStdinEnd = env.HANGAR_STOP_ON_STDIN_END === '1';
  const launcher = env.HANGAR_LAUNCHER || undefined;
  for (const n of SERVER_DROPPED_ENV) delete env[n];
  return { port, parentPid, uiDist, stopOnStdinEnd, launcher };
}
