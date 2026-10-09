import type { Dictionary } from './keys.ts';
import { accountEn } from './en/account.ts';
import { artifactEn } from './en/artifact.ts';
import { commonEn } from './en/common.ts';
import { configEn } from './en/config.ts';
import { externalEn } from './en/external.ts';
import { homeEn } from './en/home.ts';
import { httpEn } from './en/http.ts';
import { launchEn } from './en/launch.ts';
import { mcpEn } from './en/mcp.ts';
import { newSessionEn } from './en/newSession.ts';
import { platformEn } from './en/platform.ts';
import { projectEn } from './en/project.ts';
import { projectsEn } from './en/projects.ts';
import { promptEn } from './en/prompt.ts';
import { retentionEn } from './en/retention.ts';
import { runEn } from './en/run.ts';
import { sessionEn } from './en/session.ts';
import { sessionsEn } from './en/sessions.ts';
import { settingsEn } from './en/settings.ts';
import { summaryEn } from './en/summary.ts';
import { syncEn } from './en/sync.ts';
import { systemEn } from './en/system.ts';
import { todoEn } from './en/todo.ts';
import { usageEn } from './en/usage.ts';

/** 英語の辞書。文は領域ごとのファイル（`en/<領域>.ts`）にあり、ここは束ねるだけである。 */
export const en: Dictionary = {
  ...accountEn,
  ...artifactEn,
  ...commonEn,
  ...configEn,
  ...externalEn,
  ...homeEn,
  ...httpEn,
  ...launchEn,
  ...mcpEn,
  ...newSessionEn,
  ...platformEn,
  ...projectEn,
  ...projectsEn,
  ...promptEn,
  ...retentionEn,
  ...runEn,
  ...sessionEn,
  ...sessionsEn,
  ...settingsEn,
  ...summaryEn,
  ...syncEn,
  ...systemEn,
  ...todoEn,
  ...usageEn,
};
