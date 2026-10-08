import { spawn, spawnSync, type ChildProcess, type StdioOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 子プロセスの標準出力を、一時ファイルへ書かせて読む。
// claude は標準出力がパイプだと非同期に書き、書き切る前に終わることがある。Node の子プロセスのパイプで読むと、
// 2.1.293 の --help（22KB）が macOS では 8KB か 16KB で切れた。ファイルへの書き込みは同期なので、終わった時点で全部そろっている。

export type CaptureOptions = {
  /** 時間の上限。過ぎたら SIGKILL で止めて投げる。 */
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** 標準入力に流す文字列。渡さなければ標準入力は開かない。 */
  stdin?: string;
  /** 標準エラーを集めるか。集めないときは捨てる。標準エラーはパイプのままなので、短い知らせにだけ使う。 */
  stderr?: boolean;
  /** cmd.exe を通すか（Windows の .cmd と .bat）。引数は引用されないので、hangar が決めた固定の語だけを渡す。 */
  shell?: boolean;
  /** 標準出力の上限のバイト数。越えたら投げる。既定は 1MB（execFile の maxBuffer と同じ）。 */
  maxBytes?: number;
  /** 一時ディレクトリを作る場所。既定は OS の一時ディレクトリ。試験が渡す。 */
  tmpDir?: string;
};

/** 終わった子の終了コードと出力。シグナルで終わったときの終了コードは null。 */
export type Captured = { code: number | null; stdout: string; stderr: string };

const DEFAULT_MAX_BYTES = 1024 * 1024;

type Out = { dir: string; file: string; fd: number };

function openOut(tmpDir: string): Out {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'hangar-out-'));
  const file = path.join(dir, 'stdout');
  try {
    return { dir, file, fd: fs.openSync(file, 'w') };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** 子と同じ開き口を持つので、位置は子が書いた末尾にある。中身はパスから読み直す。 */
function readOut(out: Out, maxBytes: number): string {
  if (fs.fstatSync(out.fd).size > maxBytes) throw new Error(`標準出力が上限（${maxBytes} バイト）を越えました`);
  return fs.readFileSync(out.file, 'utf8');
}

function closeOut(out: Out): void {
  try { fs.closeSync(out.fd); } catch { /* 閉じ済み */ }
  // Windows では、止めた cmd.exe の子がまだ握っていると消せない。そのときは OS の一時ディレクトリの掃除に任せる。
  try { fs.rmSync(out.dir, { recursive: true, force: true }); } catch { /* 消せなくても読み取りの結果は変えない */ }
}

function stdioOf(out: Out, o: CaptureOptions): StdioOptions {
  return [o.stdin === undefined ? 'ignore' : 'pipe', out.fd, o.stderr ? 'pipe' : 'ignore'];
}

const timeoutError = (ms: number) => new Error(`${ms} ミリ秒で応答がありませんでした`);

/**
 * file を起こし、標準出力を一時ファイルへ書かせて、終わったら読む。
 * 起こせない、時間切れ、上限を越えたときは投げる。0 以外で終わっただけなら、終了コードを返す。
 * 一時ファイルは、どの終わり方でも消す。
 */
export function captureOutput(file: string, args: string[], o: CaptureOptions): Promise<Captured> {
  return new Promise((resolve, reject) => {
    let out: Out;
    try { out = openOut(o.tmpDir ?? os.tmpdir()); } catch (e) { reject(e); return; }
    let child: ChildProcess;
    // 空や NUL 入りのパス、ENOTDIR などは spawn がその場で投げる。拒否にそろえる。
    try {
      child = spawn(o.shell ? `"${file}"` : file, args, { cwd: o.cwd, env: o.env, shell: o.shell ?? false, windowsHide: true, stdio: stdioOf(out, o) });
    } catch (e) {
      closeOut(out);
      reject(e);
      return;
    }
    let stderr = '';
    let exited = false;
    let timedOut = false;
    let done = false;
    const finish = (err: unknown, code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (timedOut) reject(timeoutError(o.timeoutMs));
        else if (err) reject(err);
        else resolve({ code, stdout: readOut(out, o.maxBytes ?? DEFAULT_MAX_BYTES), stderr });
      } catch (e) {
        reject(e);
      } finally {
        closeOut(out);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // もう終わっていて、孫が標準エラーを握っているだけなら、止める相手はいない。
      if (exited) finish(null, null);
      else child.kill('SIGKILL');
    }, o.timeoutMs);
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e) => finish(e, null));
    // 時間切れで止めたときは、孫が標準エラーを握っていても待たない。
    child.on('exit', () => { exited = true; if (timedOut) finish(null, null); });
    child.on('close', (code) => finish(null, code));
    if (child.stdin) {
      // 読まずに終わる子へ書くと EPIPE になる。捕まえないと Node ごと落ちる。
      child.stdin.on('error', () => {});
      child.stdin.end(o.stdin);
    }
  });
}

/** captureOutput の同期版。起こせない、時間切れ、上限を越えたときは投げる。 */
export function captureOutputSync(file: string, args: string[], o: CaptureOptions): Captured {
  const out = openOut(o.tmpDir ?? os.tmpdir());
  try {
    const r = spawnSync(o.shell ? `"${file}"` : file, args, { cwd: o.cwd, env: o.env, shell: o.shell ?? false, windowsHide: true, timeout: o.timeoutMs, killSignal: 'SIGKILL', input: o.stdin, encoding: 'utf8', stdio: stdioOf(out, o) });
    if (r.error) throw (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? timeoutError(o.timeoutMs) : r.error;
    return { code: r.status, stdout: readOut(out, o.maxBytes ?? DEFAULT_MAX_BYTES), stderr: r.stderr ?? '' };
  } finally {
    closeOut(out);
  }
}
