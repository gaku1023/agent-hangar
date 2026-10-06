import type { AccountsDto } from '@agent-hangar/shared';

/**
 * アカウントの試験の固定データ。2 件（primary の「会社」と a1 の「大学」）で、primary がいまのアカウント。
 * 値は仮のもの。メールアドレスは example のドメインだけを使う。
 */
export const accountsFixture: AccountsDto = {
  currentId: 'primary',
  accounts: [
    { id: 'primary', name: '会社', dir: '/h/.claude', color: '#2a57b8', primary: true, auth: { loggedIn: true, email: 'taro@example.co.jp', plan: 'max', orgName: null, checkedAt: 1 }, usage: { fiveHour: { usedPercent: 82, resetsAt: 1000 }, sevenDay: { usedPercent: 41, resetsAt: 2000 }, updatedAt: 500 }, loginRunning: false, linkProblem: null },
    { id: 'a1', name: '大学', dir: '/h/.claude-univ', color: '#7a4a9e', primary: false, auth: { loggedIn: true, email: 'taro@example.ac.jp', plan: 'enterprise', orgName: null, checkedAt: 1 }, usage: { fiveHour: { usedPercent: 12, resetsAt: 1000 }, sevenDay: { usedPercent: 9, resetsAt: 2000 }, updatedAt: 500 }, loginRunning: false, linkProblem: null },
  ],
  sessions: { s9: 'a1' },
};
