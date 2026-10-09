import type { Dictionary } from './keys.ts';
import { accountJa } from './ja/account.ts';
import { accountSwitcherJa } from './ja/accountSwitcher.ts';
import { artifactJa } from './ja/artifact.ts';
import { commonJa } from './ja/common.ts';
import { configJa } from './ja/config.ts';
import { confirmJa } from './ja/confirm.ts';
import { externalJa } from './ja/external.ts';
import { headerJa } from './ja/header.ts';
import { homeJa } from './ja/home.ts';
import { httpJa } from './ja/http.ts';
import { launchJa } from './ja/launch.ts';
import { listJa } from './ja/list.ts';
import { mcpJa } from './ja/mcp.ts';
import { newProjectJa } from './ja/newProject.ts';
import { newSessionJa } from './ja/newSession.ts';
import { pauseJa } from './ja/pause.ts';
import { platformJa } from './ja/platform.ts';
import { projectJa } from './ja/project.ts';
import { projectsJa } from './ja/projects.ts';
import { promoteJa } from './ja/promote.ts';
import { promptJa } from './ja/prompt.ts';
import { retentionJa } from './ja/retention.ts';
import { retentionDialogJa } from './ja/retentionDialog.ts';
import { rowJa } from './ja/row.ts';
import { runJa } from './ja/run.ts';
import { sessionJa } from './ja/session.ts';
import { sessionsJa } from './ja/sessions.ts';
import { settingsJa } from './ja/settings.ts';
import { shortcutsJa } from './ja/shortcuts.ts';
import { sidebarJa } from './ja/sidebar.ts';
import { summaryJa } from './ja/summary.ts';
import { syncJa } from './ja/sync.ts';
import { systemJa } from './ja/system.ts';
import { todoJa } from './ja/todo.ts';
import { usageJa } from './ja/usage.ts';

/** 日本語の辞書。文は領域ごとのファイル（`ja/<領域>.ts`）にあり、ここは束ねるだけである。 */
export const ja: Dictionary = {
  ...accountJa,
  ...accountSwitcherJa,
  ...artifactJa,
  ...commonJa,
  ...configJa,
  ...confirmJa,
  ...externalJa,
  ...headerJa,
  ...homeJa,
  ...httpJa,
  ...launchJa,
  ...listJa,
  ...mcpJa,
  ...newProjectJa,
  ...newSessionJa,
  ...pauseJa,
  ...platformJa,
  ...projectJa,
  ...projectsJa,
  ...promoteJa,
  ...promptJa,
  ...retentionJa,
  ...retentionDialogJa,
  ...rowJa,
  ...runJa,
  ...sessionJa,
  ...sessionsJa,
  ...settingsJa,
  ...shortcutsJa,
  ...sidebarJa,
  ...summaryJa,
  ...syncJa,
  ...systemJa,
  ...todoJa,
  ...usageJa,
};
