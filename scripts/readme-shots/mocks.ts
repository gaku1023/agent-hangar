// 全場面のページに効く、API の応答の差し替え（使用量など）。
// 撮影用の画面の右上に出る使用量のゲージと同期の表示を、見本の値で埋める。
// 使用量はサーバが持つ実際の応答（bootstrap の accounts と、WebSocket の accounts.update）の値だけを書き換える。
// 応答の形はそのまま保つので、ほかの場面の見え方は変わらない。
import type { ApiMock } from './kit.ts';

export const MOCKS: ApiMock[] = [];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MIN = 60_000;

/** 見本の枠。Claude は 5 時間 42%（あと約 2 時間）、週 63%。Codex は 5 時間 18%、週 31%。 */
function demoAccounts(accounts: Json): Json {
  if (!Array.isArray(accounts?.accounts)) return accounts;
  const now = Date.now();
  const list = (accounts.accounts as Json[]).map((a, i) => i > 0 ? a : ({
    ...a,
    name: 'メイン',
    auth: { loggedIn: true, email: 'demo@example.com', plan: 'Max', orgName: null, checkedAt: now },
    usage: {
      fiveHour: { usedPercent: 42, resetsAt: Math.floor((now + 125 * MIN) / 1000) * 1000 },
      sevenDay: { usedPercent: 63, resetsAt: Math.floor((now + 3 * 24 * 60 * MIN) / 1000) * 1000 },
      updatedAt: now - 2 * MIN,
    },
  }));
  const codexUsage = {
    fiveHour: { usedPercent: 18, resetsAt: Math.floor((now + 190 * MIN) / 1000) * 1000 },
    sevenDay: { usedPercent: 31, resetsAt: Math.floor((now + 5 * 24 * 60 * MIN) / 1000) * 1000 },
    updatedAt: now - 5 * MIN,
  };
  return {
    ...accounts,
    accounts: list,
    // Codex のアカウント（1 件）。ヘッダの面に Codex の節と「＋」が出る。
    codex: {
      currentId: 'primary',
      accounts: [{ id: 'primary', name: 'メイン', dir: '/Users/demo/.codex', color: '#7a4a9e', primary: true, auth: { loggedIn: true, email: 'demo@example.com', plan: 'plus', orgName: null, checkedAt: now }, usage: codexUsage, loginRunning: false, linkProblem: null }],
      sessions: {},
    },
    agents: {
      codex: {
        fiveHour: { usedPercent: 18, resetsAt: Math.floor((now + 190 * MIN) / 1000) * 1000 },
        sevenDay: { usedPercent: 31, resetsAt: Math.floor((now + 5 * 24 * 60 * MIN) / 1000) * 1000 },
        updatedAt: now - 5 * MIN,
        plan: 'plus',
      },
    },
  };
}

/** 同期の見本。クラウドにつないで、1 分前に済んだ状態（本物のクラウドには触らない）。 */
function demoSync(sync: Json): Json {
  const now = Date.now();
  return { ...sync, state: 'idle', url: 'https://hangar-demo.example.workers.dev', lastPullAt: now - 40_000, lastPushAt: now - 40_000, pending: 0, error: null, deviceCount: 2, paused: false, limitedUntil: null, skipped: [], sweepPending: 0, oncePass: false, diskShort: null };
}

/** 本物のサーバの JSON 応答を受け、値だけ書き換える。match は pathname。 */
export const PATCHES: { match: string; patch(json: Json): Json }[] = [
  { match: '/api/bootstrap', patch: (j) => ({ ...j, accounts: demoAccounts(j.accounts), sync: demoSync(j.sync) }) },
  { match: '/api/accounts', patch: demoAccounts },
  { match: '/api/sync/status', patch: demoSync },
];

/** WebSocket のイベントを受け、値だけ書き換える。 */
export function patchEvent(ev: Json): Json {
  if (ev.type === 'accounts.update') return { ...ev, accounts: demoAccounts(ev.accounts) };
  if (ev.type === 'sync.status') return { ...ev, status: demoSync(ev.status) };
  return ev;
}
