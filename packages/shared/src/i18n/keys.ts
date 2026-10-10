import type { MessageSpec } from './messageSpec.ts';
import { accountKeys } from './keys/account.ts';
import { accountSwitcherKeys } from './keys/accountSwitcher.ts';
import { artifactKeys } from './keys/artifact.ts';
import { commonKeys } from './keys/common.ts';
import { configKeys } from './keys/config.ts';
import { configSyncKeys } from './keys/configSync.ts';
import { configSyncUiKeys } from './keys/configSyncUi.ts';
import { confirmKeys } from './keys/confirm.ts';
import { externalKeys } from './keys/external.ts';
import { headerKeys } from './keys/header.ts';
import { homeKeys } from './keys/home.ts';
import { httpKeys } from './keys/http.ts';
import { launchKeys } from './keys/launch.ts';
import { listKeys } from './keys/list.ts';
import { mcpKeys } from './keys/mcp.ts';
import { newProjectKeys } from './keys/newProject.ts';
import { newSessionKeys } from './keys/newSession.ts';
import { noticesKeys } from './keys/notices.ts';
import { muxKeys } from './keys/mux.ts';
import { pauseKeys } from './keys/pause.ts';
import { platformKeys } from './keys/platform.ts';
import { projectKeys } from './keys/project.ts';
import { projectsKeys } from './keys/projects.ts';
import { projectScreenKeys } from './keys/projectScreen.ts';
import { promoteKeys } from './keys/promote.ts';
import { promptKeys } from './keys/prompt.ts';
import { retentionKeys } from './keys/retention.ts';
import { retentionDialogKeys } from './keys/retentionDialog.ts';
import { rowKeys } from './keys/row.ts';
import { runKeys } from './keys/run.ts';
import { sessionKeys } from './keys/session.ts';
import { sessionsKeys } from './keys/sessions.ts';
import { settingsKeys } from './keys/settings.ts';
import { shortcutsKeys } from './keys/shortcuts.ts';
import { sidebarKeys } from './keys/sidebar.ts';
import { summaryKeys } from './keys/summary.ts';
import { syncKeys } from './keys/sync.ts';
import { systemKeys } from './keys/system.ts';
import { todoKeys } from './keys/todo.ts';
import { usageKeys } from './keys/usage.ts';
import { mediatorKeys } from './keys/mediator.ts';
import { runtimeKeys } from './keys/runtime.ts';
import { primitivesKeys } from './keys/primitives.ts';
import { composerKeys } from './keys/composer.ts';
import { toolsKeys } from './keys/tools.ts';
import { transcriptKeys } from './keys/transcript.ts';
import { terminalKeys } from './keys/terminal.ts';
import { pagerKeys } from './keys/pager.ts';
import { paletteKeys } from './keys/palette.ts';
import { connKeys } from './keys/conn.ts';
import { toastsKeys } from './keys/toasts.ts';
import { cloudUsageKeys } from './keys/cloudUsage.ts';
import { readinessKeys } from './keys/readiness.ts';
import { compatKeys } from './keys/compat.ts';
import { dbKeys } from './keys/db.ts';

/**
 * 文言の鍵の一覧。鍵ごとに、その文が受け取る引数の名前を並べる。
 * 鍵は `領域.部品.意味` の形にする。画面の文は領域を画面の名前に、サーバの文は領域を資源や層の名前にする。画面をまたぐものは common にする。
 * 一覧は領域ごとのファイル（`keys/<領域>.ts`）に割ってあり、ここは束ねるだけである。
 * 領域の名前はファイルの名前と同じで、ファイルは自分の領域の鍵だけを持つ（試験 layout.test.ts で見る）。
 * 辞書（ja.ts、en.ts）も同じ領域ごとのファイル（`ja/<領域>.ts`、`en/<領域>.ts`）を束ねた `Record<MessageKey, string>` なので、鍵が辞書に無いときも、辞書にあって鍵に無いときも、型検査で止まる。
 * 引数の名前が辞書の文の `{名前}` とそろっていることは、試験（t.test.ts）で見る。
 *
 * 領域を足すときは、`keys/`、`ja/`、`en/` に同じ名前のファイルを足し、この 3 つの束ね役（keys.ts、ja.ts、en.ts）に 1 行ずつ足す。
 *
 * common.button.cancel、session.kill.confirm、sessions.list.count の 3 つは、仕組みを通すための見本で、まだ画面では使っていない。
 * ほかは、サーバが出す文である。HTTP のエラー、起動の失敗、MCP の道具の説明と結果、Claude に渡す指示が入っている。
 */
export const MESSAGES = {
  ...accountKeys,
  ...accountSwitcherKeys,
  ...artifactKeys,
  ...commonKeys,
  ...configKeys,
  ...configSyncKeys,
  ...configSyncUiKeys,
  ...confirmKeys,
  ...externalKeys,
  ...headerKeys,
  ...homeKeys,
  ...httpKeys,
  ...launchKeys,
  ...listKeys,
  ...mcpKeys,
  ...newProjectKeys,
  ...newSessionKeys,
  ...noticesKeys,
  ...muxKeys,
  ...pauseKeys,
  ...platformKeys,
  ...projectKeys,
  ...projectsKeys,
  ...projectScreenKeys,
  ...promoteKeys,
  ...promptKeys,
  ...retentionKeys,
  ...retentionDialogKeys,
  ...rowKeys,
  ...runKeys,
  ...sessionKeys,
  ...sessionsKeys,
  ...settingsKeys,
  ...shortcutsKeys,
  ...sidebarKeys,
  ...summaryKeys,
  ...syncKeys,
  ...systemKeys,
  ...todoKeys,
  ...usageKeys,
  ...mediatorKeys,
  ...runtimeKeys,
  ...primitivesKeys,
  ...composerKeys,
  ...toolsKeys,
  ...transcriptKeys,
  ...terminalKeys,
  ...pagerKeys,
  ...paletteKeys,
  ...connKeys,
  ...toastsKeys,
  ...cloudUsageKeys,
  ...readinessKeys,
  ...compatKeys,
  ...dbKeys,
} as const satisfies MessageSpec;

export type MessageKey = keyof typeof MESSAGES;
/** その鍵の文が受け取る引数の名前。引数の無い鍵では never である。 */
export type MessageParamName<K extends MessageKey> = (typeof MESSAGES)[K][number];
export type MessageParams<K extends MessageKey> = { [P in MessageParamName<K>]: string | number };
/** `t()` の最後の引数。引数の無い鍵では渡せず、ある鍵では省けない。 */
export type MessageArgs<K extends MessageKey> = [MessageParamName<K>] extends [never] ? [] : [params: MessageParams<K>];
export type Dictionary = Record<MessageKey, string>;
