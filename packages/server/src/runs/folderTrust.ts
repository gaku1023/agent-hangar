import { FOLDER_TRUST_TOOL, type LiveSessionDto } from '@agent-hangar/shared';
import type { LiveSource } from '../agent/types.ts';
import type { Timers } from '../sync/engine.ts';
import { parseTrustDialog, type TrustDialog } from '../provider/claude-code/screen/trustDialog.ts';

/** 信頼の確認が出ていないか、画面を読む間隔。 */
export const TRUST_WATCH_EVERY_MS = 1_500;

/**
 * hangar が起こした claude が、会話の前に出す「フォルダの信頼」の確認を、実行中の一覧へ載せる写し。
 * claude は確認に答えるまで登録（~/.claude/sessions）も本文も作らないので、確認が出ている間は live が無く、
 * サイドバーは灰色の休み、別の PC は「まだ会話がありません」と読む。ここで入力待ち（waitingFor が permission、道具が FolderTrust）の行を足す。
 * 画面から確認が消えるか、登録が現れたら外す（登録の行が正しい。LiveHub は同じ会話の行が重なったら、こちらを捨てる）。
 * 手元の一時の事実なので、DB にも同期にも載せない。
 */
export class FolderTrustLive implements LiveSource {
  private rows = new Map<string, LiveSessionDto>();
  private list: LiveSessionDto[] = [];
  private readonly cbs = new Set<(live: LiveSessionDto[]) => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** providerSessionId の会話に、確認が出ている。同じパスなら何もしない。 */
  set(providerSessionId: string, o: { cwd: string; path: string }): void {
    if (this.rows.get(providerSessionId)?.permission?.input === o.path) return;
    this.rows.set(providerSessionId, {
      sessionId: providerSessionId, status: 'waiting', name: null, nameSource: null, cwd: o.cwd, pid: 0, statusAt: this.now(),
      waitingFor: 'permission', permission: { tool: FOLDER_TRUST_TOOL, input: o.path, description: null },
    });
    this.changed();
  }

  clear(providerSessionId: string): void {
    if (this.rows.delete(providerSessionId)) this.changed();
  }

  has(providerSessionId: string): boolean {
    return this.rows.has(providerSessionId);
  }

  private changed(): void {
    this.list = [...this.rows.values()];
    for (const cb of this.cbs) cb(this.list);
  }

  start(): void {}
  stop(): void {}
  current(): LiveSessionDto[] { return this.list; }
  onChange(cb: (live: LiveSessionDto[]) => void): () => void {
    this.cbs.add(cb);
    return () => { this.cbs.delete(cb); };
  }
  kick(): void {}
  isRunning(): boolean { return false; }
}

/** 実行中の一覧の行が、この写しが足した行か。 */
export const isFolderTrustRow = (l: LiveSessionDto): boolean => l.pid === 0 && l.permission?.tool === FOLDER_TRUST_TOOL;

/**
 * 起こした run の画面を読み、信頼の確認が出ているかを知らせる。
 * 登録が現れる（registered が真）まで everyMs ごとに読み、確認の有無かパスが変わったときだけ onDialog を呼ぶ（消えたら null）。
 * 登録が現れたら、確認を外して止まる。run の終わりでは、返す関数で止める。何度呼んでもよい。
 * 読めなかった回は、投げずに次を待つ。遅い読みの上に次の読みを重ねない。
 */
export function watchTrustDialog(o: { capture: () => string | Promise<string>; registered: () => boolean; onDialog: (d: TrustDialog | null) => void; timers: Pick<Timers, 'setInterval' | 'clearInterval'>; everyMs?: number }): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let reading = false;
  let last: string | null = null;
  const stop = (): void => {
    stopped = true;
    if (timer !== null) o.timers.clearInterval(timer);
    timer = null;
  };
  const seen = (screen: string): void => {
    if (stopped) return;
    const d = parseTrustDialog(screen);
    const sig = d === null ? null : d.path;
    if (sig === last) return;
    last = sig;
    o.onDialog(d);
  };
  timer = o.timers.setInterval(() => {
    if (reading || stopped) return;
    if (o.registered()) {
      if (last !== null) o.onDialog(null);
      stop();
      return;
    }
    let screen: string | Promise<string>;
    try { screen = o.capture(); } catch { return; }
    if (typeof screen === 'string') { seen(screen); return; }
    reading = true;
    void screen.then(seen, () => {}).finally(() => { reading = false; });
  }, o.everyMs ?? TRUST_WATCH_EVERY_MS);
  timer.unref?.();
  return stop;
}
