import * as pty from 'node-pty';
import { createPtyCloser } from './close.ts';
import { ensureSpawnHelper } from './helper.ts';
import type { PtySpawn } from './relay.ts';

// prebuild の spawn-helper は実行権限が落ちていることがあるので、読み込まれた時点で直しておく。
ensureSpawnHelper();

/**
 * node-pty 1.2.0-beta.15 の Windows の内側（WindowsTerminal._agent、WindowsPtyAgent）のうち、解放に使う所。
 * 公開の口ではないので、形を確かめてから使う。別の版で形が違えば使わない。
 */
type ConptyAgent = {
  _pty: number;
  _useConptyDll: boolean;
  _ptyNative: { kill(id: number, useConptyDll: boolean): void };
  _conoutSocketWorker: { dispose(): void };
};

function conptyAgentOf(p: unknown): ConptyAgent | null {
  const a = (p as { _agent?: Partial<ConptyAgent> } | null | undefined)?._agent;
  if (!a || typeof a._pty !== 'number' || typeof a._ptyNative?.kill !== 'function' || typeof a._conoutSocketWorker?.dispose !== 'function') return null;
  return a as ConptyAgent;
}

/**
 * Windows の pty の pseudoconsole を閉じ、conout の Worker を放す。node-pty の kill のうち、補助のプロセスを起こす所だけを抜いたもの。
 * native の kill は ClosePseudoConsole と pipe の後始末をする。conhost が終わり、つながっている子も終わる。
 * conout の Worker は dispose の 1 秒後に terminate される（出力を流し切るための node-pty の待ち）。
 * どちらも投げたら捨てる。内側の形が違うときは何もせず false を返し、呼んだ側は今までの閉じ方に戻る（close.ts）。
 */
export function releaseConpty(p: unknown): boolean {
  const a = conptyAgentOf(p);
  if (!a) return false;
  const native = a._ptyNative;
  // 閉じた pseudoconsole の handle を、待ちの後に落ちる node-pty の kill がもう一度閉じないよう、この pty の native の kill だけを空にする。
  // 子が生きている間は native の表に baton が残るので、そのまま呼ぶと同じ handle に ClosePseudoConsole が 2 回届く。
  // ほかの呼び出し（resize など）は元の native へそのまま通す。
  a._ptyNative = Object.assign(Object.create(native) as ConptyAgent['_ptyNative'], { kill: () => {} });
  try { native.kill(a._pty, a._useConptyDll); } catch { /* 既に閉じている */ }
  try { a._conoutSocketWorker.dispose(); } catch { /* 既に放している */ }
  return true;
}

/**
 * Windows の pty の conout の Worker だけを放す。子が自分で終わったときに使う。
 * node-pty は子が自分で終わった経路で、出力の socket を閉じるだけで Worker を放さないので、pty ごとにスレッドが 1 本残る。
 * pseudoconsole（conhost）はこの経路では閉じられない。native の側が子の終わりで baton を表から消し、hpc の handle を持つ所が無くなるためである（上流の作り）。
 */
export function disposeConoutWorker(p: unknown): void {
  const a = conptyAgentOf(p);
  if (!a) return;
  try { a._conoutSocketWorker.dispose(); } catch { /* 既に放している */ }
}

/** 本物の node-pty。テストでは偽の spawn を渡すので、このファイルはサーバ起動時にだけ読まれる。 */
export const nodePtySpawn: PtySpawn = (file, args, opts) => {
  const p = pty.spawn(file, args, { name: opts.name, cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env as Record<string, string> });
  const win = process.platform === 'win32';
  // Windows の kill は補助のプロセスを起こすので、閉じ方を close.ts に任せる。つないだ後なら、pseudoconsole と conout の Worker を直に放す。
  // node-pty 1.2 の Windows の pid は、子を pseudoconsole につないだ後で決まる。spawn の直後に写さず、閉じる時に読む。
  const closer = createPtyCloser({ pid: () => p.pid, hardKill: () => p.kill(), killPid: (pid) => process.kill(pid), release: () => releaseConpty(p) });
  let closed = false;
  p.onExit(() => {
    closer.markExited();
    if (win) disposeConoutWorker(p);
  });
  return {
    get pid() { return p.pid; },
    onData: (cb) => { p.onData(cb); },
    onExit: (cb) => { p.onExit((e) => cb({ exitCode: e.exitCode })); },
    // 閉じた後の書き込みは捨てる。Windows で pseudoconsole を閉じた後に書くと、入力の pipe が閉じていて投げうる。
    write: (d) => { if (!closed) p.write(d); },
    // 子が終わった後の resize は投げる（Unix は ioctl の EBADF、Windows は "Cannot resize a pty that has already exited"）。
    // 大きさの知らせは WebSocket の受け口から届くので、投げるとサーバごと落ちる。終わった端末の大きさは要らないので捨てる。
    resize: (c, r) => { try { p.resize(c, r); } catch { /* 終わっている */ } },
    kill: () => { closed = true; closer.close(); },
  };
};
