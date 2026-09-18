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
    return { ...process.env, ...(this.o.accountId ? { CLOUDFLARE_ACCOUNT_ID: this.o.accountId } : {}), WRANGLER_SEND_METRICS: 'false' };
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

/** `wrangler whoami` の表からアカウント ID を拾う。ログインしていなければ null。 */
export function parseAccountId(whoami: string): string | null {
  const m = /\b([0-9a-f]{32})\b/.exec(whoami);
  return m ? m[1]! : null;
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
