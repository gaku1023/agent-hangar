import fs from 'node:fs';
import path from 'node:path';
import { ensureMode } from '../platform/secure.ts';

/**
 * run に渡す秘密の環境（opencode の TUI のパスワードなど）。
 *
 * 環境で渡すつもりでも、tmux の `new-session -e K=V` に載せると、tmux クライアントの argv に一瞬見え、
 * tmux のセッションの環境（`tmux show-environment`）にも run の間ずっと残る。
 * そこで値は run ごとの 0600 のファイルに置き、包み（hangar-run.sh、hangar-run.mjs）には場所だけを `HANGAR_SECRET_ENV` で渡す。
 * 包みは読んで自分の環境に入れ、エージェントを起こす前にファイルを消す。
 * 包みが読まずに終わった分は、run の終わりと、起動と起動時の回復の掃除で消す。
 * Windows では置き場をユーザーのプロファイルの下（hangar の home）にして、その権限で守る（platform/secure.ts）。
 */

/** 置き場のディレクトリの名前。<home> の下に作る。 */
export const SECRET_ENV_DIR = 'run-env';

/** 包みへファイルの場所を渡す変数の名前。 */
export const SECRET_ENV_VAR = 'HANGAR_SECRET_ENV';

/** ファイル名に使える形だけを通す。run の ID は hangar が作るが、外から来た値を素通しにしない。 */
function safeName(runId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new Error(`invalid run id for the secret env: ${JSON.stringify(runId)}`);
  return runId;
}

/** その run の秘密の環境のファイル。 */
export function secretEnvPath(home: string, runId: string): string {
  return path.join(home, SECRET_ENV_DIR, `${safeName(runId)}.env`);
}

/**
 * 中身。1 行に 1 つ、`名前=値` の形で書く。
 * 包みは 1 行ずつ読んで export するので、改行と NUL の入った値と、変数の名前に使えない名前は断る。
 */
export function secretEnvBody(vars: Record<string, string>): string {
  let body = '';
  for (const [name, value] of Object.entries(vars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid name for the secret env: ${JSON.stringify(name)}`);
    if (/[\r\n\0]/.test(value)) throw new Error(`the secret env value of ${name} has a line break or NUL`);
    body += `${name}=${value}\n`;
  }
  return body;
}

/**
 * 包みへ引数のファイルの場所を渡す変数の名前。
 * 長い最初の指示を tmux の引数に入れると「command too long」で断られるので（launch/command.ts の ARGV_INLINE_MAX）、
 * エージェントの引数を run ごとのファイルに書き、包みが読んで消してから起こす。
 * 中身は最初の指示や注入の文で、人の目に触れる argv と同じものだが、秘密の環境と同じ置き場と掃除に乗せる。
 */
export const ARGV_FILE_VAR = 'HANGAR_ARGV_FILE';

/** その run の引数のファイル。 */
export function argvFilePath(home: string, runId: string): string {
  return path.join(home, SECRET_ENV_DIR, `${safeName(runId)}.argv`);
}

/** 中身。引数は改行や引用符を含むので、各引数の後ろに NUL を置く。NUL は引数に入らないので、入っていれば断る。 */
export function argvFileBody(argv: readonly string[]): string {
  for (const a of argv) if (a.includes('\0')) throw new Error('an argument has a NUL');
  return argv.map((a) => `${a}\0`).join('');
}

/** その run の引数を 0600 で書き、ファイルの場所を返す。 */
export function writeArgvFile(home: string, runId: string, argv: readonly string[], platform: NodeJS.Platform = process.platform): string {
  const file = argvFilePath(home, runId);
  const body = argvFileBody(argv);
  writePrivate(file, body, platform);
  return file;
}

/** 置き場を 0700 にして、0600 で書く。 */
function writePrivate(file: string, body: string, platform: NodeJS.Platform): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  ensureMode(dir, 0o700, platform);
  fs.writeFileSync(file, body, { mode: 0o600 });
  // mode は新しく作るときにしか効かないので、既にある分は直す。
  ensureMode(file, 0o600, platform);
}

/** その run の秘密の環境を 0600 で書き、置き場を 0700 にして、ファイルの場所を返す。 */
export function writeSecretEnv(home: string, runId: string, vars: Record<string, string>, platform: NodeJS.Platform = process.platform): string {
  const file = secretEnvPath(home, runId);
  writePrivate(file, secretEnvBody(vars), platform);
  return file;
}

/** その run の秘密の環境と引数のファイルを消す。無くても何も言わない。 */
export function removeSecretEnv(home: string, runId: string): void {
  for (const file of [secretEnvPath(home, runId), argvFilePath(home, runId)]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // 消せなかった分は次の起動の掃除で当たる。
    }
  }
}

/**
 * 生きている run のもの以外を消す。消せた名前を返す。
 * 包みが読む前に run が終わった分と、run の終わりで消し損ねた分を、次の起動と起動時の回復で拾う。
 */
export function pruneSecretEnvs(home: string, aliveRunIds: Iterable<string>): string[] {
  const dir = path.join(home, SECRET_ENV_DIR);
  const alive = new Set(aliveRunIds);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const m = /^([^.]+)\.(?:env|argv)$/.exec(name);
    if (!m || alive.has(m[1]!)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removed.push(name);
    } catch {
      // 掃除の失敗で起動を止めない。
    }
  }
  return removed;
}
