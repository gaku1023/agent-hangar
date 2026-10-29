import type { AgentKind, LaunchResultDto, RunDto } from '@agent-hangar/shared';
import { PRIMARY_ACCOUNT_ID, type Account, type AccountStore } from '../config/accounts.ts';
import { ensureAccountLinks, linkProblemMessage } from '../provider/claude-code/config/accountLinks.ts';
import { fixableConflicts } from '../platform/links.ts';
import { ensureCodexAccountLinks } from '../provider/codex/config/accountLinks.ts';
import type { Db } from '../db/open.ts';
import { accountOfSession } from '../db/queries.ts';
import { RunError } from './errors.ts';
import { msg } from '../i18n/message.ts';

/**
 * run を起こすときのアカウントの解決。
 * どのアカウントで起こすか、その置き場で起こすための環境変数は何か、を答える。
 * store を持たないときは、アカウントを使わない構成として、どの問いにも「無い」と答える。
 */
export class RunAccounts {
  /**
   * deviceId はこの PC。渡せば、セッションのアカウントをこの PC の run だけから引く（accountFor）。
   * アカウントの id と名前は PC ごとの設定なので、ほかの PC の run のアカウントをこの PC で引くと、別のアカウントで起きる。
   */
  constructor(private readonly deps: { db: Db; claudeDir: string; store?: AccountStore; deviceId?: string;
    /** Codex のアカウント。持たなければ（設定の codexEnabled が切など）、Codex はアカウント無しで起こす。primaryDir は最初のアカウントの置き場（~/.codex）。 */
    codex?: { store: AccountStore; primaryDir: string } }) {}

  /** そのエージェントのアカウントの store。Claude 以外は Codex だけが持つ。 */
  private storeOf(agent: AgentKind): AccountStore | undefined {
    if (agent === 'claude-code') return this.deps.store;
    return agent === 'codex' ? this.deps.codex?.store : undefined;
  }

  /** そのエージェントがアカウントを使う構成か（store を持つか）。 */
  has(agent: AgentKind = 'claude-code'): boolean {
    return !!this.storeOf(agent);
  }

  /** そのエージェントのいまのアカウントを変える。store を持たなければ何もしない。 */
  setCurrent(agent: AgentKind, id: string): void {
    this.storeOf(agent)?.setCurrent(id);
  }

  /**
   * 起動に使うアカウントを解く。id が無ければいまのアカウントで、store を持たなければ null を返す。
   * 知らない id は 400 で断る。黙って別のアカウントで起こすと、利用者が選んだものと違う枠を使うためである。
   */
  resolve(id: string | undefined, agent: AgentKind = 'claude-code'): Account | null {
    const store = this.storeOf(agent);
    if (!store) return null;
    if (id === undefined) return store.current();
    const a = store.get(id);
    if (!a) throw new RunError(400, msg('account.error.notFound'));
    return a;
  }

  /**
   * そのセッションを最後に動かしたアカウント。記録が無い、またはアカウントが消えていれば最初のアカウント。
   * PC を持てば、この PC の最後の run のアカウントにする（A → B → A と戻ったときに、この PC で前に使ったアカウントで起こす）。
   * この PC に run が無ければ、この PC でいま選んでいるアカウントにする。ほかの PC の run のアカウントは引かない。
   */
  accountFor(sessionId: string, agent: AgentKind = 'claude-code'): string {
    const store = this.storeOf(agent);
    const id = accountOfSession(this.deps.db, sessionId, this.deps.deviceId);
    if (id) return store?.get(id) ? id : PRIMARY_ACCOUNT_ID;
    return (this.deps.deviceId !== undefined ? store?.current().id : undefined) ?? PRIMARY_ACCOUNT_ID;
  }

  /** accountFor のアカウントそのもの。再開、フォーク、attach が、前と同じアカウントで起こすのに使う。 */
  lastUsed(sessionId: string, agent: AgentKind = 'claude-code'): Account | null {
    return this.storeOf(agent) ? this.resolve(this.accountFor(sessionId, agent), agent) : null;
  }

  /** その置き場を持つ登録済みのアカウント。未登録なら null。 */
  byDir(dir: string): Account | null {
    return this.deps.store?.byDir(dir) ?? null;
  }

  /**
   * アカウントの置き場で起こすための環境変数。最初のアカウントは何も足さない。
   * 起動の前にリンクを確かめる。リンクの場所に別のものがあれば、起こさずに伝える。
   */
  envFor(a: Account | null, agent: AgentKind = 'claude-code'): Record<string, string> {
    if (!a || a.id === PRIMARY_ACCOUNT_ID) return {};
    if (agent === 'codex') {
      const c = this.deps.codex;
      if (!c) return {};
      const r = ensureCodexAccountLinks(c.primaryDir, a.dir);
      // 張れなかった項目（Windows の開発者モードが切のときのファイル）は、そのアカウントだけのものとして起動する。札で案内する。
      this.refuseConflicts(r.conflicts, c.primaryDir, a, 'codex');
      return { CODEX_HOME: a.dir };
    }
    const r = ensureAccountLinks(this.deps.claudeDir, a.dir);
    this.refuseConflicts(r.conflicts, this.deps.claudeDir, a, 'claude-code');
    return { CLAUDE_CONFIG_DIR: a.dir };
  }

  /**
   * リンクの場所に別のものがあれば断る。
   * 全部が「中身が違うファイル」なら、画面が修復のダイアログを開けるよう、符号と直せるファイル名を応答に載せる。
   * ディレクトリが混じれば、直しても通らないので、文だけにする。
   */
  private refuseConflicts(conflicts: string[], primaryDir: string, a: Account, agent: 'claude-code' | 'codex'): void {
    if (conflicts.length === 0) return;
    const fixable = fixableConflicts(primaryDir, a.dir, conflicts);
    const problem = linkProblemMessage(conflicts, [], fixable)!;
    const all = fixable.length === conflicts.length;
    throw new RunError(400, problem, all ? { code: 'account_link_conflict', accountId: a.id, agent, files: fixable } : undefined);
  }
}

/**
 * アカウントの切り替えが、run の寿命の側に頼むこと。RunManager が渡す。
 * 断るもの（session、precheck、resume）は RunError を投げる。
 */
export type SwitchHost = {
  session(sessionId: string): { id: string; provider: string; provider_session_id: string; cwd: string };
  hasBody(sessionId: string): boolean;
  /**
   * そのセッションを再開する cwd で起動できるかを確かめる。
   * cwd は共有の行のものではなく、再開に使う形（ほかの PC のパスをこの PC へ読み替えた後）である。
   */
  precheck(sessionId: string): void;
  /** Claude のバックグラウンドのサービスが持つセッションか。 */
  isBackground(providerSessionId: string): boolean;
  /** Claude のレジストリに残っているか。 */
  isLive(providerSessionId: string): boolean;
  aliveRun(sessionId: string): RunDto | null;
  kill(runId: string): void;
  resume(sessionId: string, extra: { account: string }): LaunchResultDto | Promise<LaunchResultDto>;
  sleep(ms: number): Promise<void>;
};

/**
 * 開いているセッションを、別のアカウントで再開し直す。
 * 動いていれば止め、Claude のレジストリから消えるのを待ってから、同じ会話を選んだアカウントの置き場で起こす。
 * 本文は置き場の間で共有なので写さない。
 * 断る理由（知らないアカウント、壊れたリンク、同じアカウント、本文が無い、起動できない、外で動いている）は、止める前に確かめる。止めてから断ると、利用者の作業だけが失われる。
 */
export async function switchAccount(accounts: RunAccounts, host: SwitchHost, sessionId: string, accountId: string): Promise<LaunchResultDto> {
  const s = host.session(sessionId);
  const agent = s.provider as AgentKind;
  const account = accounts.resolve(accountId, agent);
  if (!account) throw new RunError(400, msg('account.error.notFound'));
  if (accounts.accountFor(s.id, agent) === account.id) throw new RunError(409, msg('account.switch.sameAccount'));
  accounts.envFor(account, agent);
  // resume の前提も止める前に確かめる。本文が無いと、止めた時点でセッションの行ごと消え、起こし直せない。
  // Codex の再開は thread/resume で会話を開くので、hangar の本文の写しは要らない。
  if (agent === 'claude-code' && !host.hasBody(s.id)) throw new RunError(400, msg('account.switch.noTranscript'));
  host.precheck(s.id);
  // バックグラウンドのサービスは置き場ごとに別で、jobs と sessions は共有のリンクになる。この組み合わせの動きは実物で確かめていないので、確かめが済むまで断る。
  if (host.isBackground(s.provider_session_id)) throw new RunError(409, msg('account.switch.background'));
  const alive = host.aliveRun(s.id);
  // hangar の run が無いのにレジストリに残っているのは、hangar の外で動いている Claude である。止められないので待たずに断る。
  if (!alive && host.isLive(s.provider_session_id)) throw new RunError(409, msg('run.error.runningOutside'));
  if (alive) host.kill(alive.id);
  for (let waited = 0; host.isLive(s.provider_session_id); waited += 250) {
    if (waited >= 5000) throw new RunError(409, msg('account.switch.previousStillRunning'));
    await host.sleep(250);
  }
  const result = await host.resume(s.id, { account: account.id });
  // 付け替えたアカウントを、そのエージェントのいまのアカウントにする（Claude のいまのアカウントは変えない）。
  if (agent !== 'claude-code') accounts.setCurrent(agent, account.id);
  return result;
}
