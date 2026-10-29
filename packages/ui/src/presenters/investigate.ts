import { isNoticeOp, setupGuidePrompt, type AccountDto, type AgentAccountsDto, type AgentKind, type InvestigateContext, type NewSessionSeed } from '@agent-hangar/shared';
import { clientPlatform } from '../keys.ts';
import type { Store } from '../store/store.ts';
import { AGENT_TEXT } from './agentText.ts';
import { osLabel } from './cloudMember.ts';
import { translatorOf } from './i18n.ts';
import { liveReadiness, readinessQuoteLines } from './readiness.ts';

type AccountAgent = 'claude-code' | 'codex';

/** エージェントのアカウントの組。opencode と、アカウントを読んでいないときは null。 */
function accountSet(store: Store, agent: AgentKind): AgentAccountsDto | null {
  if (agent === 'codex') return store.accounts?.codex ?? null;
  return agent === 'claude-code' ? store.accounts ?? null : null;
}

/** エラーに絡むエージェントとアカウント。再開とフォークは元のセッションから引く（どのアカウントにも載っていなければ主のアカウント）。 */
function involved(store: Store, ctx: InvestigateContext): { agent: AgentKind | null; account: AccountDto | null } {
  const session = ctx.sessionId ? store.sessions[ctx.sessionId] : undefined;
  const agent = ctx.agent ?? session?.provider ?? null;
  const set = agent ? accountSet(store, agent) : null;
  if (!set) return { agent, account: null };
  const id = ctx.accountId ?? (ctx.sessionId ? set.sessions[ctx.sessionId] ?? set.accounts.find((a) => a.primary)?.id : undefined);
  return { agent, account: set.accounts.find((a) => a.id === id) ?? null };
}

/** 壊れていない（共有のリンクに問題が無く、ログアウトしていない）アカウントか。 */
const healthy = (a: AccountDto): boolean => a.linkProblem === null && a.linkConflicts.length === 0 && a.auth?.loggedIn !== false;

/** 調べる会話を起こすアカウント。エラーに絡むものと壊れたものを避け、いまのアカウント、主のアカウントの順に選ぶ。どちらも駄目なら付けない。 */
function pickAccount(set: AgentAccountsDto, avoid: string | null): string | undefined {
  const ok = (a: AccountDto | undefined): a is AccountDto => !!a && a.id !== avoid && healthy(a);
  const current = set.accounts.find((a) => a.id === set.currentId);
  const primary = set.accounts.find((a) => a.primary);
  return ok(current) ? current.id : ok(primary) ? primary.id : undefined;
}

/**
 * 「エージェントで調査…」で開く新しいセッションのダイアログの種（NewSessionSeed）。
 * 依頼の文と、エラーの引用（操作、エラー、コード、ファイル、エージェント、アカウントと設定ディレクトリ、版と OS）に分ける。
 * 手元の会話に渡すものなので、パスもエラーの文も伏せない。言葉はアプリの表示言語にする。
 */
export function investigateSeed(store: Store, ctx: InvestigateContext, platform: string = clientPlatform()): NewSessionSeed {
  const t = translatorOf(store);
  const { agent, account } = involved(store, ctx);
  // 注意（エラーではないもの）は、操作の行を持たず、「注意：」で始める。
  const notice = isNoticeOp(ctx.op);
  const lines = [
    ...(isNoticeOp(ctx.op) ? [t('newSession.investigate.line.notice', { text: ctx.message })] : [
      t('newSession.investigate.line.action', { text: t(`newSession.investigate.op.${ctx.op}`) }),
      t('newSession.investigate.line.error', { text: ctx.message }),
    ]),
    ...(ctx.code ? [t('newSession.investigate.line.code', { text: ctx.code })] : []),
    ...(ctx.files?.length ? [t('newSession.investigate.line.files', { text: ctx.files.join(t('common.list.separator')) })] : []),
    ...(agent ? [t('newSession.investigate.line.agent', { text: t(AGENT_TEXT[agent].launchLabel) })] : []),
    ...(account ? [t('newSession.investigate.line.account', { name: account.name, dir: account.dir })] : []),
    `hangar ${store.version} / ${osLabel(platform)}`,
  ];
  const accounts = pickAccounts(store, agent, account?.id ?? null);
  return { request: t(notice ? 'newSession.investigate.requestNotice' : 'newSession.investigate.request'), quote: lines.join('\n'), ...(accounts ? { accounts } : {}), ...(notice ? { tone: 'info' as const } : {}) };
}

/** エージェントごとに、調べる会話を起こすアカウント（pickAccount）。avoid は agent のアカウントのうち避ける id。どれも選べなければ undefined。 */
function pickAccounts(store: Store, agent: AgentKind | null, avoid: string | null): NewSessionSeed['accounts'] {
  const accounts: { [K in AccountAgent]?: string } = {};
  for (const a of ['claude-code', 'codex'] as const) {
    const set = accountSet(store, a);
    const id = set ? pickAccount(set, agent === a ? avoid : null) : undefined;
    if (id) accounts[a] = id;
  }
  return Object.keys(accounts).length ? accounts : undefined;
}

/** セットアップのすゝめを、セッションのダイアログで開けるか。tmux と claude が揃っていなければ、今までどおり一言をコピーさせる。 */
export const canLaunchGuide = (store: Store): boolean => !!store.setupGuide && !!store.readiness && store.readiness.tools.tmux.ok && store.readiness.tools.claude.ok;

/**
 * 「エージェントで診断…」（setupGuide.launch）で開く新しいセッションのダイアログの種。
 * 依頼の文はすゝめの一言（設定の札とホームの「仕上げ」の行が写させていたもの）で、引用はいまの準備の状況（帯と同じ文）と版と OS である。
 * 引用はエラーではないので中立の色にする。すゝめの写しか準備の確かめがまだ無ければ null。
 */
export function setupGuideSeed(store: Store, platform: string = clientPlatform()): NewSessionSeed | null {
  if (!store.setupGuide || !store.readiness) return null;
  const t = translatorOf(store);
  const lines = [...readinessQuoteLines(liveReadiness(store.readiness, Object.values(store.projects)), t, platform), `hangar ${store.version} / ${osLabel(platform)}`];
  const accounts = pickAccounts(store, null, null);
  return { request: setupGuidePrompt(t, store.setupGuide), quote: lines.join('\n'), ...(accounts ? { accounts } : {}), tone: 'info' };
}
