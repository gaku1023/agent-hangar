/**
 * Claude Code が自分の子（Bash と hook と statusline のコマンド、裏のセッション）に立てる印。
 * hangar が起こすもの（4177 のサーバ、tmux サーバ、claude の run、シェルのタブ、外の端末からの run）へは持ち込まない。
 *
 * hangar を Claude Code のセッションの Bash から起こすと（`open`、osascript の launch、`hangar start`）、
 * 呼び手の環境が殻とサーバに入り、サーバが起こした tmux サーバの全体の環境に残って、hangar の claude がそれを継ぐ。
 * 2026-10-08 に、利用者の手元の殻とサーバと既定の tmux サーバで、別のセッションのこの印を見つけた。
 * 印を持って始まった claude は、別のセッションの子として振る舞う。
 * CLAUDE_CODE_CHILD_SESSION があると再開の一覧と履歴から外れ、CLAUDE_CODE_SESSION_KIND=bg なら裏のセッションと見なし、
 * CLAUDE_CODE_SESSION_NAME はそのままレジストリの名前になる。
 *
 * 入れるのは、Claude Code が立てると確かめられたものだけである。
 * 利用者が自分で立てる設定として公開の文書（環境変数の一覧）に載っているもの（CLAUDE_CONFIG_DIR、CLAUDE_CODE_USE_BEDROCK、
 * CLAUDE_CODE_OAUTH_TOKEN、CLAUDE_CODE_EFFORT_LEVEL、ANTHROPIC_* など）は入れない。外すと利用者の設定が効かなくなる。
 * Claude Code が子に立てても、ほかの道具や利用者と共有する名前（GIT_EDITOR、COREPACK_ENABLE_AUTO_PIN、TRACEPARENT など）は、
 * 名前だけでは誰が立てたか分からないので入れない。
 *
 * これも Claude Code が公開を約束していない形なので、互換の契約のそばに置く。確かめたのは 2.1.295 である。
 * 正本はこの一覧で、殻（apps/desktop/src-tauri/src/server.rs の INHERITED_ENV_DROPPED）はその写しを試験で縛る。
 */
export const CLAUDE_CHILD_ENV: readonly string[] = [
  // 文書が「Claude Code が子に立てる」と書くもの。手元の Claude Code の Bash の環境にもあった。
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  // 文書に無く、手元の Bash の環境にあり、Claude Code の本体が子の環境に入れているもの（起動の入口、実行ファイルの場所、対話の有無、エージェントの名乗り）。
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'AI_AGENT',
  // 文書が「Remote Control でつないでいる間、Bash と hook に立つ」と書くもの。
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  // 裏のセッション（claude --bg）の起こし方で立ち、そのセッションの Bash が継ぐもの。CLAUDE_JOB_DIR は文書が継ぐと書く。
  // ほかは本体が起動のときに消さずに残すことを、本体の中で確かめた。
  'CLAUDE_CODE_SESSION_KIND',
  'CLAUDE_CODE_SESSION_NAME',
  'CLAUDE_JOB_DIR',
  'CLAUDE_BG_BACKEND',
  'CLAUDE_BG_SOURCE',
];
