import type { Dictionary } from './keys.ts';
import { accountEn } from './en/account.ts';
import { accountSwitcherEn } from './en/accountSwitcher.ts';
import { artifactEn } from './en/artifact.ts';
import { commonEn } from './en/common.ts';
import { configEn } from './en/config.ts';
import { configSyncEn } from './en/configSync.ts';
import { configSyncUiEn } from './en/configSyncUi.ts';
import { confirmEn } from './en/confirm.ts';
import { externalEn } from './en/external.ts';
import { headerEn } from './en/header.ts';
import { homeEn } from './en/home.ts';
import { httpEn } from './en/http.ts';
import { launchEn } from './en/launch.ts';
import { listEn } from './en/list.ts';
import { mcpEn } from './en/mcp.ts';
import { newProjectEn } from './en/newProject.ts';
import { newSessionEn } from './en/newSession.ts';
import { noticesEn } from './en/notices.ts';
import { muxEn } from './en/mux.ts';
import { pauseEn } from './en/pause.ts';
import { platformEn } from './en/platform.ts';
import { projectEn } from './en/project.ts';
import { projectsEn } from './en/projects.ts';
import { projectScreenEn } from './en/projectScreen.ts';
import { promoteEn } from './en/promote.ts';
import { promptEn } from './en/prompt.ts';
import { retentionEn } from './en/retention.ts';
import { retentionDialogEn } from './en/retentionDialog.ts';
import { rowEn } from './en/row.ts';
import { runEn } from './en/run.ts';
import { sessionEn } from './en/session.ts';
import { sessionsEn } from './en/sessions.ts';
import { settingsEn } from './en/settings.ts';
import { shortcutsEn } from './en/shortcuts.ts';
import { sidebarEn } from './en/sidebar.ts';
import { summaryEn } from './en/summary.ts';
import { syncEn } from './en/sync.ts';
import { systemEn } from './en/system.ts';
import { todoEn } from './en/todo.ts';
import { usageEn } from './en/usage.ts';
import { mediatorEn } from './en/mediator.ts';
import { runtimeEn } from './en/runtime.ts';
import { primitivesEn } from './en/primitives.ts';
import { composerEn } from './en/composer.ts';
import { toolsEn } from './en/tools.ts';
import { transcriptEn } from './en/transcript.ts';
import { terminalEn } from './en/terminal.ts';
import { pagerEn } from './en/pager.ts';
import { paletteEn } from './en/palette.ts';
import { connEn } from './en/conn.ts';
import { toastsEn } from './en/toasts.ts';
import { cloudUsageEn } from './en/cloudUsage.ts';
import { readinessEn } from './en/readiness.ts';
import { compatEn } from './en/compat.ts';
import { dbEn } from './en/db.ts';
import { updateEn } from './en/update.ts';

/** 英語の辞書。文は領域ごとのファイル（`en/<領域>.ts`）にあり、ここは束ねるだけである。 */
export const en: Dictionary = {
  ...accountEn,
  ...accountSwitcherEn,
  ...artifactEn,
  ...commonEn,
  ...configEn,
  ...configSyncEn,
  ...configSyncUiEn,
  ...confirmEn,
  ...externalEn,
  ...headerEn,
  ...homeEn,
  ...httpEn,
  ...launchEn,
  ...listEn,
  ...mcpEn,
  ...newProjectEn,
  ...newSessionEn,
  ...noticesEn,
  ...muxEn,
  ...pauseEn,
  ...platformEn,
  ...projectEn,
  ...projectsEn,
  ...projectScreenEn,
  ...promoteEn,
  ...promptEn,
  ...retentionEn,
  ...retentionDialogEn,
  ...rowEn,
  ...runEn,
  ...sessionEn,
  ...sessionsEn,
  ...settingsEn,
  ...shortcutsEn,
  ...sidebarEn,
  ...summaryEn,
  ...syncEn,
  ...systemEn,
  ...todoEn,
  ...usageEn,
  ...mediatorEn,
  ...runtimeEn,
  ...primitivesEn,
  ...composerEn,
  ...toolsEn,
  ...transcriptEn,
  ...terminalEn,
  ...pagerEn,
  ...paletteEn,
  ...connEn,
  ...toastsEn,
  ...cloudUsageEn,
  ...readinessEn,
  ...compatEn,
  ...dbEn,
  ...updateEn,
};
