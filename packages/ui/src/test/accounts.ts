import type { AccountsDto } from '@agent-hangar/shared';

/**
 * アカウントの試験の固定データ。2 件（primary の「会社」と a1 の「大学」）で、primary がいまのアカウント。
 * 値は仮のもの。メールアドレスは example のドメインだけを使う。
 */
/** 枠が戻る時刻。試験の時計がいつでも、まだ戻っていない遠い先にしておく（過ぎた窓は 0% に読まれる）。 */
export const FIVE_RESETS = 4_000_000_000_000;
export const SEVEN_RESETS = 4_000_100_000_000;

export const accountsFixture: AccountsDto = {
  currentId: 'primary',
  accounts: [
    { id: 'primary', name: '会社', dir: '/h/.claude', color: '#2a57b8', primary: true, auth: { loggedIn: true, email: 'taro@example.co.jp', plan: 'max', orgName: null, checkedAt: 1 }, usage: { fiveHour: { usedPercent: 82, resetsAt: FIVE_RESETS }, sevenDay: { usedPercent: 41, resetsAt: SEVEN_RESETS }, updatedAt: 500 }, loginRunning: false, linkProblem: null },
    { id: 'a1', name: '大学', dir: '/h/.claude-univ', color: '#7a4a9e', primary: false, auth: { loggedIn: true, email: 'taro@example.ac.jp', plan: 'enterprise', orgName: null, checkedAt: 1 }, usage: { fiveHour: { usedPercent: 12, resetsAt: FIVE_RESETS }, sevenDay: { usedPercent: 9, resetsAt: SEVEN_RESETS }, updatedAt: 500 }, loginRunning: false, linkProblem: null },
  ],
  sessions: { s9: 'a1' },
};
