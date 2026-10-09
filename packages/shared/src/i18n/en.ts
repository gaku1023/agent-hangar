import type { Dictionary } from './keys.ts';
import { accountEn } from './en/account.ts';
import { accountSwitcherEn } from './en/accountSwitcher.ts';
import { artifactEn } from './en/artifact.ts';
import { commonEn } from './en/common.ts';
import { configEn } from './en/config.ts';
import { confirmEn } from './en/confirm.ts';
import { externalEn } from './en/external.ts';
import { httpEn } from './en/http.ts';
import { launchEn } from './en/launch.ts';
import { mcpEn } from './en/mcp.ts';
import { newProjectEn } from './en/newProject.ts';
import { pauseEn } from './en/pause.ts';
import { platformEn } from './en/platform.ts';
import { projectEn } from './en/project.ts';
import { promoteEn } from './en/promote.ts';
import { promptEn } from './en/prompt.ts';
import { retentionEn } from './en/retention.ts';
import { retentionDialogEn } from './en/retentionDialog.ts';
import { runEn } from './en/run.ts';
import { sessionEn } from './en/session.ts';
import { sessionsEn } from './en/sessions.ts';
import { settingsEn } from './en/settings.ts';
import { shortcutsEn } from './en/shortcuts.ts';
import { summaryEn } from './en/summary.ts';
import { syncEn } from './en/sync.ts';
import { systemEn } from './en/system.ts';
import { todoEn } from './en/todo.ts';
import { usageEn } from './en/usage.ts';

/** 英語の辞書。文は領域ごとのファイル（`en/<領域>.ts`）にあり、ここは束ねるだけである。 */
export const en: Dictionary = {
  ...accountEn,
  ...accountSwitcherEn,
  ...artifactEn,
  ...commonEn,
  ...configEn,
  ...confirmEn,
  ...externalEn,
  ...httpEn,
  ...launchEn,
  ...mcpEn,
  ...newProjectEn,
  ...pauseEn,
  ...platformEn,
  ...projectEn,
  ...promoteEn,
  ...promptEn,
  ...retentionEn,
  ...retentionDialogEn,
  ...runEn,
  ...sessionEn,
  ...sessionsEn,
  ...settingsEn,
  ...shortcutsEn,
  ...summaryEn,
  ...syncEn,
  ...systemEn,
  ...todoEn,
  ...usageEn,
};
