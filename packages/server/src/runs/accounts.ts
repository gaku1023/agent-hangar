import type { LaunchResultDto, RunDto } from '@agent-hangar/shared';
import { PRIMARY_ACCOUNT_ID, type Account, type AccountStore } from '../config/accounts.ts';
import { ensureAccountLinks, linkProblem } from '../config/accountLinks.ts';
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
  constructor(private readonly deps: { db: Db; claudeDir: string; store?: AccountStore }) {}

  /**
   * 起動に使うアカウントを解く。id が無ければいまのアカウントで、store を持たなければ null を返す。
   * 知らない id は 400 で断る。黙って別のアカウントで起こすと、利用者が選んだものと違う枠を使うためである。
   */
  resolve(id: string | undefined): Account | null {
    const store = this.deps.store;
    if (!store) return null;
    if (id === undefined) return store.current();
    const a = store.get(id);
    if (!a) throw new RunError(400, msg('account.error.notFound'));
    return a;
  }

  /** そのセッションを最後に動かしたアカウント。記録が無い、またはアカウントが消えていれば最初のアカウント。 */
  accountFor(sessionId: string): string {
    const id = accountOfSession(this.deps.db, sessionId);
    return id && this.deps.store?.get(id) ? id : PRIMARY_ACCOUNT_ID;
  }

  /** accountFor のアカウントそのもの。再開、フォーク、attach が、前と同じアカウントで起こすのに使う。 */
  lastUsed(sessionId: string): Account | null {
    return this.deps.store ? this.resolve(this.accountFor(sessionId)) : null;
  }

  /** その置き場を持つ登録済みのアカウント。未登録なら null。 */
  byDir(dir: string): Account | null {
    return this.deps.store?.byDir(dir) ?? null;
  }

  /**
   * アカウントの置き場で起こすための環境変数。最初のアカウントは何も足さない。
   * 起動の前にリンクを確かめる。リンクの場所に別のものがあれば、起こさずに伝える。
   */
  envFor(a: Account | null): Record<string, string> {
    if (!a || a.id === PRIMARY_ACCOUNT_ID) return {};
    const problem = linkProblem(ensureAccountLinks(this.deps.claudeDir, a.dir).conflicts);
    if (problem) throw new RunError(400, problem);
    return { CLAUDE_CONFIG_DIR: a.dir };
  }
}

/**
 * アカウントの切り替えが、run の寿命の側に頼むこと。RunManager が渡す。
 * 断るもの（session、precheck、resume）は RunError を投げる。
 */
export type SwitchHost = {
  session(sessionId: string): { id: string; provider_session_id: string; cwd: string };
  hasBody(sessionId: string): boolean;
  /** その cwd で起動できるかを確かめる。 */
  precheck(cwd: string): void;
  /** Claude のバックグラウンドのサービスが持つセッションか。 */
  isBackground(providerSessionId: string): boolean;
  /** Claude のレジストリに残っているか。 */
  isLive(providerSessionId: string): boolean;
  aliveRun(sessionId: string): RunDto | null;
  kill(runId: string): void;
  resume(sessionId: string, extra: { account: string }): LaunchResultDto;
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
  const account = accounts.resolve(accountId);
  if (!account) throw new RunError(400, msg('account.error.notFound'));
  if (accounts.accountFor(s.id) === account.id) throw new RunError(409, msg('account.switch.sameAccount'));
  accounts.envFor(account);
  // resume の前提も止める前に確かめる。本文が無いと、止めた時点でセッションの行ごと消え、起こし直せない。
  if (!host.hasBody(s.id)) throw new RunError(400, msg('account.switch.noTranscript'));
  host.precheck(s.cwd);
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
  return host.resume(s.id, { account: account.id });
}
