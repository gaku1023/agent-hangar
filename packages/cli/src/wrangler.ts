import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; input?: string }) => Promise<ExecResult>;
/** 標準入出力を利用者に渡したまま走らせる実行。終了コードだけを返す。 */
export type Interactive = (args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<number>;

/**
 * 出力を集める既定の実行。
 * `input` があれば標準入力に書いて閉じる。
 * 秘密は必ずこちらで渡す。argv に載せると `ps -axww -o command=` から読めてしまう。
 */
export const defaultExec: Exec = (cmd, args, o) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    p.on('error', (e) => resolve({ code: 127, stdout, stderr: stderr + e.message }));
    p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (o.input !== undefined) p.stdin.write(o.input);
    p.stdin.end();
  });

/** wrangler login のように、利用者自身が答える実行。 */
export const defaultInteractive: Interactive = (args, o) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: o.cwd, env: o.env, stdio: 'inherit' });
    p.on('close', (code) => resolve(code ?? 1));
    p.on('error', () => resolve(127));
  });

/**
 * wrangler がエージェント（AI のコーディング道具）の中で走っているかを見る印。
 * wrangler 4.135 は am-i-vibing 0.5.0 の一覧で判定し（src/utils/detect-agent.ts）、見るのは環境変数だけである（祖先のプロセスは見ない）。
 * エージェントと判定すると、deploy は workers.dev のサブドメインが無いアカウントで、問わずに package.json の名前で登録しに行く
 * （runDeployCommandHandler の autoRegisterWorkersDevSubdomain）。
 * サブドメインは Worker の URL に出て、あとで変えると URL と参加トークンが変わるので、利用者が自分で決める。
 * hangar の中の claude から setup cloud を打つことがあるので、ここに挙げた印は wrangler に渡さない。
 * 一覧は、その道具だけが立てる変数に絞った。TERM_PROGRAM や PAGER のように他の用途のある変数との組み合わせで見るものは外さない。
 */
export const AGENT_MARKER_ENV: readonly string[] = [
  // Claude Code
  'CLAUDECODE',
  // OpenCode
  'OPENCODE', 'OPENCODE_BIN_PATH', 'OPENCODE_SERVER', 'OPENCODE_APP_INFO', 'OPENCODE_MODES',
  // Antigravity、Gemini CLI、OpenAI Codex、Amp、Auggie、Qwen Code、Pi、Crush
  'ANTIGRAVITY_AGENT', 'ANTIGRAVITY_PROJECT_ID', 'GEMINI_CLI', 'CODEX_THREAD_ID', 'AMP_CURRENT_THREAD_ID', 'AUGMENT_AGENT', 'QWEN_CODE', 'PI_CODING_AGENT', 'CRUSH',
];

/** Claude Code が子へ渡す印の接頭辞。wrangler の判定には使われないが、Claude Code の中から呼んだ跡を wrangler に持ち込まない。 */
const CLAUDE_CODE_PREFIX = 'CLAUDE_CODE_';

/**
 * wrangler に渡す環境。
 * 手元の環境から、エージェントの印（AGENT_MARKER_ENV と CLAUDE_CODE_ で始まるもの）を外す。
 * アカウント ID が決まっていればそれを立て、計測は切る。base は書き換えない。
 */
export function wranglerEnv(base: NodeJS.ProcessEnv, accountId: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (AGENT_MARKER_ENV.includes(k) || k.startsWith(CLAUDE_CODE_PREFIX)) continue;
    env[k] = v;
  }
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  env.WRANGLER_SEND_METRICS = 'false';
  return env;
}

export type WranglerRunnerOptions = {
  /** wrangler を持っているパッケージの場所。普通は packages/cloud である。 */
  cloudDir: string;
  /** 見つかっていれば Cloudflare のアカウント ID。環境変数で渡す。 */
  accountId: string | null;
  exec?: Exec;
  interactive?: Interactive;
  log?: (line: string) => void;
};

/**
 * packages/cloud に同梱した wrangler を、アカウント ID を環境変数で渡して実行する。
 * 秘密（参加用の秘密のハッシュ、API トークン）は argv に載せず、標準入力から渡す。
 */
export class WranglerRunner {
  constructor(private readonly o: WranglerRunnerOptions) {}

  /**
   * wrangler の実行ファイル。workspaces が root に巻き上げても cloud の package.json から解決できる。
   * wrangler の exports は `.` と `./package.json` しか公開していないので、`wrangler/bin/wrangler.js` は
   * 直接は解決できない（ERR_PACKAGE_PATH_NOT_EXPORTED になる）。package.json を解決して bin を引く。
   */
  bin(): string {
    try {
      const pkgPath = createRequire(path.join(this.o.cloudDir, 'package.json')).resolve('wrangler/package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { bin?: string | Record<string, string> };
      const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.wrangler;
      if (rel) return path.resolve(path.dirname(pkgPath), rel);
    } catch {
      // 解決できないときは決め打ちに落ちる。実行のときに見つからない旨が出る。
    }
    return path.join(this.o.cloudDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  }

  private env(): NodeJS.ProcessEnv {
    return wranglerEnv(process.env, this.o.accountId);
  }

  withAccount(accountId: string): WranglerRunner {
    return new WranglerRunner({ ...this.o, accountId });
  }

  /** 引数は印字するが、標準入力に渡す中身は印字しない。 */
  run(args: string[], input?: string): Promise<ExecResult> {
    this.o.log?.(`$ wrangler ${args.join(' ')}`);
    return (this.o.exec ?? defaultExec)(process.execPath, [this.bin(), ...args], { cwd: this.o.cloudDir, env: this.env(), input });
  }

  /** wrangler login のように標準入出力を利用者に渡す実行。 */
  runInteractive(args: string[]): Promise<number> {
    this.o.log?.(`$ wrangler ${args.join(' ')}`);
    return (this.o.interactive ?? defaultInteractive)([this.bin(), ...args], { cwd: this.o.cloudDir, env: this.env() });
  }
}

/** Cloudflare のアカウント。ID は 32 桁の 16 進である。 */
export type CfAccount = { id: string; name: string };

/** whoami から読んだもの。ログインしていなければ loggedIn が偽で、accounts は空である。 */
export type WhoamiResult = { loggedIn: boolean; accounts: CfAccount[] };

const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

/** アカウント ID の形か。 */
export function isAccountId(s: string): boolean {
  return ACCOUNT_ID.test(s);
}

/**
 * `wrangler whoami --json` の出力を読む（wrangler 4.135 で確かめた形）。
 * ログインしていれば { loggedIn: true, accounts: [{ id, name, ... }], ... } を 4 字下げで出す。
 * ログインしていなければ {"loggedIn":false} を出して 0 以外で終わる。
 * JSON でなければ（--json を知らない古い wrangler など）null を返し、呼び手は表を読む。
 */
export function parseWhoamiJson(text: string): WhoamiResult | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let v: unknown;
  try {
    v = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || typeof (v as { loggedIn?: unknown }).loggedIn !== 'boolean') return null;
  const o = v as { loggedIn: boolean; accounts?: unknown };
  if (!o.loggedIn) return { loggedIn: false, accounts: [] };
  const accounts: CfAccount[] = [];
  for (const a of Array.isArray(o.accounts) ? o.accounts : []) {
    const id = (a as { id?: unknown } | null)?.id;
    const name = (a as { name?: unknown } | null)?.name;
    if (typeof id === 'string' && isAccountId(id)) accounts.push({ id: id.toLowerCase(), name: typeof name === 'string' ? name : '' });
  }
  return { loggedIn: true, accounts };
}

/**
 * `wrangler whoami` の表を読む（--json を持たない版のため）。
 * 表は `│ 名前 │ ID │` の行を、アカウントの数だけ並べる。ID の形の升を持つ行だけを拾う。
 * 1 つ目だけを拾うと、アカウントが複数ある人の作り先が並び順で決まってしまう。
 */
export function parseWhoamiTable(text: string): WhoamiResult {
  const accounts: CfAccount[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('│')) continue;
    const cells = line.split('│').map((c) => c.trim()).filter((c) => c !== '');
    const idx = cells.findIndex((c) => isAccountId(c));
    if (idx < 0) continue;
    accounts.push({ id: cells[idx]!.toLowerCase(), name: cells.filter((_, i) => i !== idx)[0] ?? '' });
  }
  return { loggedIn: accounts.length > 0, accounts };
}

/** `d1 create` の TOML の断片からも、`d1 info --json` の JSON からも同じ形で拾える。 */
export function parseDatabaseId(text: string): string | null {
  const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(text);
  return m ? m[0] : null;
}

export function parseWorkerUrl(deployLog: string): string | null {
  const m = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(deployLog);
  return m ? m[0] : null;
}
