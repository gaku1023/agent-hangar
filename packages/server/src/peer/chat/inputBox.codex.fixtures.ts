/**
 * Codex の TUI（codex-cli 0.167.0、Mac の tmux 3.x）の capture-pane -p -e の実物。末尾の行だけを切り出した。
 * 統括へ [hangar] を渡す前の、入力欄の空の判定（inputBox.ts の codexInputEmptyFromCapture）の見本である。
 */

/** 何度かターンを終えた後の空の入力欄。上に、直前のユーザーの入力（背景色つきの › の行）が残る。 */
export const CODEX_EMPTY_AFTER_TURNS = "\u001b[2m  └ (no output)\u001b[0m\n\n■ Conversation interrupted - use /feedback if something went wrong\n\n\u001b[48;5;8m\n\u001b[1;2m› \u001b[0m\u001b[48;5;8mCall the list_sessions tool of the hangar MCP server and tell me the result.\n\n\u001b[49m\n\u001b[1m\u001b[38;5;2m•\u001b[0m \u001b[1mCalled\u001b[0m \u001b[38;2;99;168;248mhangar.list_sessions\u001b[39m\n\u001b[2m  └ sessions: alpha-7731, beta-2290\u001b[0m\n\u001b[2m    + Show details\n\u001b[0m\n\u001b[2m• \u001b[0mThe Hangar MCP \u001b[38;2;166;227;161mlist_sessions\u001b[39m result was: \u001b[38;2;166;227;161msessions: alpha-7731, beta-2290\u001b[39m.\n\u001b[2m  └ \u001b[0;1m\u001b[38;2;243;139;168mTip:\u001b[0m Press \u001b[38;2;166;227;161m⌃r\u001b[39m to search previously entered prompts.\n\n\u001b[2m  Worked for 5s • 22:39\n\u001b[0m\n\n\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m\n\n  \u001b[38;2;246;226;183mGPT-6-Luna low\u001b[39m · \u001b[38;2;242;181;144mContext 3% used\u001b[39m · \u001b[38;2;242;181;144m258K window\u001b[39m · \u001b[38;2;233;144;169mmonthly 50% left\u001b[39m\n  \u001b[1m←\u001b[0m for agents · \u001b[1m?\u001b[0m for shortcuts                                                               ⚠ \u001b[38;2;196;167;103m1 warning\u001b[39m · \u001b[1mf2\u001b[0m to view";

/** 1 行の打ちかけ。 */
export const CODEX_TYPED = "\n\u001b[1m›\u001b[0m hello there\n\n  \u001b[38;2;246;226;183mGPT-6-Luna low\u001b[39m · \u001b[38;2;242;181;144mContext 0% used\u001b[39m · \u001b[38;2;233;144;169mmonthly 50% left\u001b[39m\n                                                                                               ⚠ \u001b[38;2;196;167;103m1 warning\u001b[39m · \u001b[1mf2\u001b[0m to view";

/** 2 行の打ちかけ（Ctrl+J で改行）。 */
export const CODEX_MULTILINE = "\n\u001b[1m›\u001b[0m line one\n  line two\n\n  \u001b[38;2;246;226;183mGPT-6-Luna low\u001b[39m · \u001b[38;2;242;181;144mContext 3% used\u001b[39m · \u001b[38;2;242;181;144m258K window\u001b[39m · \u001b[38;2;233;144;169mmonthly 50% left\u001b[39m\n                                                                                               ⚠ \u001b[38;2;196;167;103m1 warning\u001b[39m · \u001b[1mf2\u001b[0m to view";

/** 長い貼り付けの札。 */
export const CODEX_PASTED = "\n\u001b[1m›\u001b[0m \u001b[38;5;6m[Pasted Content 1501 chars]\u001b[39m\n\n  \u001b[38;2;246;226;183mGPT-6-Luna low\u001b[39m · \u001b[38;2;242;181;144mContext 3% used\u001b[39m · \u001b[38;2;242;181;144m258K window\u001b[39m · \u001b[38;2;233;144;169mmonthly 50% left\u001b[39m\n                                                                                               ⚠ \u001b[38;2;196;167;103m1 warning\u001b[39m · \u001b[1mf2\u001b[0m to view";

/** 作業中。入力欄は空のまま。 */
export const CODEX_WORKING = "\n\u001b[1m\u001b[38;2;242;242;242m•\u001b[0m \u001b[2mWorking\u001b[0m \u001b[2m(2s • \u001b[0;1mesc\u001b[0;2m to interrupt)\u001b[0m\n\n\n\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m\n\n  \u001b[38;2;246;226;183mGPT-6-Luna low\u001b[39m · \u001b[38;2;242;181;144mContext 0% used\u001b[39m · \u001b[38;2;233;144;169mmonthly 50% left\u001b[39m\n  \u001b[1m←\u001b[0m for agents · \u001b[1m?\u001b[0m for shortcuts                                                               ⚠ \u001b[38;2;196;167;103m1 warning\u001b[39m · \u001b[1mf2\u001b[0m to view";

/** コマンドの承認の札（read-only の外での実行を求めた）。選択の › が出る。 */
export const CODEX_APPROVAL = "  \u001b[1mWould you like to run the following command?\u001b[0m\n\n  Environment: \u001b[1mlocal\u001b[0m\n\n  Reason: \u001b[3mMay I run this exact command outside the read-only sandbox to create made-by-shell.txt?\u001b[0m\n\n  $ \u001b[38;2;137;180;250mecho\u001b[38;2;205;214;244m hi \u001b[38;2;148;226;213m>\u001b[38;2;205;214;244m made-by-shell.txt\u001b[39m\n\n\n\u001b[1;7m› 1. Yes, proceed (y)\n\u001b[0m  2. Yes, and don't ask again for commands that start with `echo hi > made-by-shell.txt` (\u001b[1mp\u001b[0m)\n  3. No, and tell Codex what to do differently (\u001b[1mesc\u001b[0m)\n\n  \u001b[2mPress \u001b[0;1menter\u001b[0;2m to confirm or \u001b[0;1mesc\u001b[0;2m to cancel";
