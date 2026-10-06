import { execFile } from 'node:child_process';
import type { AccountAuthDto } from '@agent-hangar/shared';
import { PRIMARY_ACCOUNT_ID, type Account } from './accounts.ts';

export type RunClaude = (bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal) => Promise<{ code: number | null; stdout: string }>;

const STATUS_TIMEOUT_MS = 10_000;
/** ブラウザでの承認を待つ上限。過ぎたら claude を終わらせ、未ログインのままにする。 */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** 置き場のログインより優先される認証の変数。渡すと、選んだアカウントではないもので動く。 */
const AUTH_OVERRIDES = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

const realRun: RunClaude = (bin, args, env, timeoutMs, signal) => new Promise((resolve, reject) => {
  execFile(bin, args, { env, timeout: timeoutMs, signal, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
    // 終了コードが 0 でないだけなら、標準出力を読む側に任せる。起動できない、時間切れは失敗にする。
    if (err) {
      const code: unknown = (err as { code?: unknown }).code;
      if (typeof code !== 'number' || (err as { killed?: boolean }).killed) return reject(err);
      return resolve({ code, stdout });
    }
    resolve({ code: 0, stdout });
  });
});

/** アカウントの置き場で claude を起こすときの環境。最初のアカウントは CLAUDE_CONFIG_DIR を付けない。 */
export function accountEnv(account: Account, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!AUTH_OVERRIDES.includes(k) && v !== undefined) env[k] = v;
  if (account.id !== PRIMARY_ACCOUNT_ID) env.CLAUDE_CONFIG_DIR = account.dir;
  return env;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** `claude auth status --json` の出力から、画面に出す 4 つだけを取り出す。 */
export function parseAuthStatus(stdout: string, now: number): AccountAuthDto | null {
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return null; }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.loggedIn !== 'boolean') return null;
  return { loggedIn: r.loggedIn, email: text(r.email), plan: text(r.subscriptionType), orgName: text(r.orgName), checkedAt: now };
}

/**
 * アカウントごとの認証の状態。claude 自身に聞くだけで、トークンは読まない。
 * ログインも claude 自身の流れ（ブラウザでの承認）に任せ、hangar は子プロセスを起こして終わるのを待つだけである。
 */
export class AccountAuth {
  private readonly cache = new Map<string, AccountAuthDto>();
  /** 走っているログイン。中止の口（AbortController）を持つ。 */
  private readonly logins = new Map<string, AbortController>();
  /** 一度でも読み終えたアカウント。読めなかった（claude が無い、失敗）ものも数える。 */
  private readonly checked = new Set<string>();
  private readonly refreshing = new Set<string>();
  private onChange: (() => void) | undefined;
  private readonly run: RunClaude;
  private readonly now: () => number;

  constructor(private readonly o: { claudeBin: () => string | null; run?: RunClaude; now?: () => number; onChange?: () => void }) {
    this.onChange = o.onChange;
    this.run = o.run ?? realRun;
    this.now = o.now ?? (() => Date.now());
  }

  /** 通知先が投げても、状態の更新は済んでいる。未処理の rejection にしない。 */
  private notify(): void {
    try { this.onChange?.(); } catch (e) { console.error('[accounts] 配信に失敗しました', e instanceof Error ? e.message : e); }
  }

  get(id: string): AccountAuthDto | null { return this.cache.get(id) ?? null; }
  loginRunning(id: string): boolean { return this.logins.has(id); }
  forget(id: string): void { this.cache.delete(id); this.checked.delete(id); }
  /** 通知先をあとから結ぶ（AccountAuth を先に作り、通知の組み立てを後にできるように）。 */
  setOnChange(fn: (() => void) | undefined): void { this.onChange = fn; }

  /**
   * まだ一度も読んでいないアカウントを、待たずに裏で 1 回だけ読む。
   * 読み込みやログインが走っている間は起こさない。読めなかったときも読んだと数え、呼ぶたびに claude を起こさない。
   */
  ensureChecked(account: Account): void {
    if (this.checked.has(account.id) || this.refreshing.has(account.id) || this.logins.has(account.id)) return;
    void this.refresh(account).catch(() => {});
  }

  async refresh(account: Account): Promise<AccountAuthDto | null> {
    const bin = this.o.claudeBin();
    let next: AccountAuthDto | null = null;
    this.refreshing.add(account.id);
    if (bin) {
      try { next = parseAuthStatus((await this.run(bin, ['auth', 'status', '--json'], accountEnv(account), STATUS_TIMEOUT_MS)).stdout, this.now()); } catch { next = null; }
    }
    this.refreshing.delete(account.id);
    this.checked.add(account.id);
    if (next) this.cache.set(account.id, next); else this.cache.delete(account.id);
    this.notify();
    return next;
  }

  /**
   * claude auth login を起こす。ブラウザは claude が開く。終わったら状態を読み直す。
   * 起こせなかった理由を返す：claude が無い（no-claude）、もう走っている（running）。
   */
  login(account: Account): 'started' | 'running' | 'no-claude' {
    const bin = this.o.claudeBin();
    if (!bin) return 'no-claude';
    if (this.logins.has(account.id)) return 'running';
    const ctl = new AbortController();
    this.logins.set(account.id, ctl);
    this.notify();
    void this.run(bin, ['auth', 'login'], accountEnv(account), LOGIN_TIMEOUT_MS, ctl.signal)
      .catch(() => null)
      .then(() => {
        // 中止されたもの（Map から外れた、あるいは別のログインに替わった）は読み直さない。
        if (this.logins.get(account.id) !== ctl) return;
        this.logins.delete(account.id);
        return this.refresh(account);
      })
      .catch(() => {});
    return 'started';
  }

  /** 走っているログインを止める。止めたら true。認証は読み直さない（ブラウザで承認していないため）。 */
  cancelLogin(id: string): boolean {
    const ctl = this.logins.get(id);
    if (!ctl) return false;
    this.logins.delete(id);
    ctl.abort();
    this.notify();
    return true;
  }
}
