import type { Hono } from 'hono';
import type { BootstrapDto } from '@agent-hangar/shared';
import { listArtifacts } from '../../artifacts/queries.ts';
import { listProjects, listSessions } from '../../db/queries.ts';
import { listTodos } from '../../projects/todos.ts';
import { buildAccountsDto } from '../accounts.ts';
import type { AppDeps } from '../deps.ts';
import { syncStatusOf } from './common.ts';
import { toSettingsDto } from './settings.ts';

/** 起動時の取得が使う依存。画面の最初の状態を 1 回で返すので、ほかの経路より広い。 */
export type BootstrapRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'deviceName' | 'version' | 'live' | 'settings' | 'runs' | 'summary' | 'indexer' | 'retention' | 'cloudUsage' | 'accounts' | 'devices' | 'sync' | 'syncSkipped' | 'syncSweep' | 'syncOncePass'>;

/** 起動時の取得。画面が最初に読む状態を、1 回の応答にまとめて返す。 */
export function bootstrapRoutes(api: Hono, deps: BootstrapRouteDeps): void {
  const { db, deviceId } = deps;
  const syncStatus = syncStatusOf(deps);
  const accountsDeps = deps.accounts;

  api.get('/bootstrap', (c) => {
    const live = deps.live();
    const alive = deps.runs.listAlive();
    const body: BootstrapDto = {
      sync: syncStatus(),
      devices: deps.devices(),
      device: { id: deviceId, name: deps.deviceName },
      settings: toSettingsDto(deps.settings()),
      projects: listProjects(db, deviceId, live),
      sessions: listSessions(db, live, { deviceId }),
      live,
      runs: alive.runs,
      tabs: alive.tabs,
      todos: listTodos(db),
      artifacts: listArtifacts(db),
      summaryPending: deps.summary.pending(),
      index: deps.indexer.progress(),
      version: deps.version,
      retention: deps.retention.current(),
      cloudUsage: deps.cloudUsage.current(),
      accounts: buildAccountsDto(accountsDeps, { checkLinks: true }),
    };
    return c.json(body);
  });
}
