import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { Language } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { msg, render } from '../i18n/message.ts';
import type { AgentKind } from '../agent/types.ts';
import { isExportAgent } from './agentSync.ts';
import { ledgerKeyFor } from './ledgerKey.ts';
import type { RunManager } from '../runs/manager.ts';
import { sha256Stream } from './crypto.ts';
import { FLUSH_AGAIN_MS } from './flushOnRunEnd.ts';
import { asksForMe, writeAnswer, type TakeoverAsk, type TakeoverResult } from './takeoverRows.ts';

export type TakeoverResponderDeps = {
  db: Db;
  deviceId: string;
  runs: Pick<RunManager, 'getRun' | 'kill'>;
  /** そのセッションの本文を上げる。同期していない端末では何もしない。 */
  flushSession(uuid: string): Promise<void>;
  /** 書いた応答をすぐクラウドへ送る。 */
  pushNow(): Promise<void>;
  /** 止める前に、その run の端末へ 1 行を残す。 */
  notePane?(tmuxName: string, text: string): void;
  deviceName(id: string): string;
  language: () => Language;
  /** 止めてから 2 度目の flushSession までの待ち。既定は run の終わりと同じ。 */
  againMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * opencode の会話の口（provider/opencode/transfer.ts と export.ts）。省けば opencode の会話も Claude と同じ順で止める。
   * quiesce は、会話の作業を interrupt して idle になるまで待つ（hangar の会話の ID と opencode の会話の ID）。
   * exportFile は、上げるために書き出したファイルの場所（`~/.agent-hangar/opencode/export/<会話>.json`）。
   */
  opencode?: {
    quiesce(sessionId: string, providerSessionId: string): Promise<unknown>;
    exportFile(providerSessionId: string): string;
  };
};

/**
 * ほかの PC から「この会話を止めてほしい」と頼まれたとき、止めて応答を書く。
 * 頼みの行は pull で届き、この PC あてで、取り下げも応答もされていないものだけを扱う（asksForMe）。
 * 頼んだ側は、応答の版（本文の sha256 と size）が台帳に降りてくるのを待ってから引き継ぐ。
 * 応答の版は、止めたあとの手元の本文のファイルから作る（手元に無ければ台帳の版）。
 * 先に頼みを扱った方が止め、同じ run への後の頼みは、すでに動いていないので not_running になる。
 *
 * opencode の会話は順番を変える（docs/design.md「opencode の本文の同期」）。
 * TUI を閉じてもサーバの側の作業は続き、止めたあとの本文は serve の外からしか書き出せないので、
 * interrupt して idle を待ち、書き出し直して上げてから、TUI と serve を止める。版は書き出したファイルで答える。
 */
export class TakeoverResponder {
  private tail: Promise<unknown> = Promise.resolve();
  /** まだ始まっていない次の scan。重なった呼び出しは 1 本にまとめる。 */
  private queued: Promise<number> | null = null;

  constructor(private readonly deps: TakeoverResponderDeps) {}

  /**
   * 自分あての頼みを古い順に扱い、答えた数を返す。
   * 走っている最中に呼ばれたら、その後ろに 1 回だけ並ぶ。同じ頼みを並行して 2 度扱わない。
   */
  scan(): Promise<number> {
    if (this.queued) return this.queued;
    const p = this.tail.then(() => { this.queued = null; return this.scanOnce(); });
    this.queued = p;
    this.tail = p.catch(() => undefined);
    return p;
  }

  private async scanOnce(): Promise<number> {
    let answered = 0;
    for (const ask of asksForMe(this.deps.db, this.deps.deviceId)) {
      try {
        await this.handle(ask);
        answered++;
      } catch (e) {
        // 止められなかった頼みは答えずに残す。次の scan で、動いていなければ not_running になる。
        console.error('[takeover] 頼みを扱えませんでした', ask.id, e instanceof Error ? e.message : e);
      }
    }
    return answered;
  }

  private async handle(ask: TakeoverAsk): Promise<void> {
    const { db, deviceId, runs } = this.deps;
    const now = this.deps.now ?? Date.now;
    const run = runs.getRun(ask.runId);
    const mine = !!run && run.deviceId === deviceId && run.sessionId === ask.sessionId && run.endedAt === null;
    const row = db.prepare('select provider, provider_session_id p from sessions where id = ?').get(ask.sessionId) as { provider: AgentKind; p: string } | undefined;
    const uuid = row?.p ?? null;
    const opencode = isExportAgent(row?.provider) && this.deps.opencode ? this.deps.opencode : null;
    let result: TakeoverResult = 'not_running';
    if (mine && opencode && uuid) {
      this.deps.notePane?.(run.tmuxName, render(this.deps.language(), msg('sync.takeover.paneNoteOpencode', { device: this.deps.deviceName(ask.fromDevice) })));
      // 止まらなくても先へ進む（書き出しは途中のターンを含みうるが、止めないまま残すよりよい）。
      await opencode.quiesce(ask.sessionId, uuid).catch((e: unknown) => console.error('[takeover] could not quiesce the opencode session', e instanceof Error ? e.message : e));
      await this.deps.flushSession(uuid);
      runs.kill(run.id, 'taken_over');
      result = 'stopped';
    } else if (mine) {
      // 止める前に端末へ残す。止めたあとは画面が閉じる。
      this.deps.notePane?.(run.tmuxName, render(this.deps.language(), msg('sync.takeover.paneNote', { device: this.deps.deviceName(ask.fromDevice) })));
      runs.kill(run.id, 'taken_over');
      result = 'stopped';
      // Claude は終わる直前まで書き足すので、少し置いてもう 1 度上げる（flushOnRunEnded と同じ作法）。
      if (uuid) await this.deps.flushSession(uuid);
      await (this.deps.sleep ?? ((ms) => new Promise<void>((r) => { setTimeout(r, ms); })))(this.deps.againMs ?? FLUSH_AGAIN_MS);
      if (uuid) await this.deps.flushSession(uuid);
    }
    const version = opencode && uuid
      ? ((await this.fileVersion(opencode.exportFile(uuid))) ?? this.transcriptVersion(row!.provider, uuid))
      : ((await this.localVersion(ask.sessionId)) ?? (uuid ? this.transcriptVersion(row?.provider ?? 'claude-code', uuid) : null));
    writeAnswer(db, deviceId, {
      askId: ask.id, runId: ask.runId, result, answeredAt: now(),
      transcriptSha256: version?.sha256 ?? null, transcriptSize: version?.size ?? null,
    });
    // 送れなくても応答の行は手元に書いてある。次の押し出しで届くので、ここでは失敗にしない。
    await this.deps.pushNow().catch((e: unknown) => console.error('[takeover] 応答をすぐには送れませんでした', e instanceof Error ? e.message : e));
  }

  /**
   * 止めたあとの、この PC の主線の本文のファイルそのものの版（平文の sha256 と大きさ）。ファイルが無ければ null。
   * 台帳ではなくファイルを読むのは、上げ損ねても flushSession は黙って戻るからである。
   * 台帳の古い版で答えると、頼んだ側は最後のターンの欠けた本文で再開する。
   * ファイルの版で答えれば、頼んだ側は台帳がそこへ追いつくまで receiving のまま待ち、追いつかなければ返事がないに落ちる。
   * 形は上げる側（uploader.ts）が台帳へ書くものと同じである（gzip と暗号の前の平文の指紋と、そのバイト数）。
   */
  private async localVersion(sessionId: string): Promise<{ sha256: string; size: number } | null> {
    const f = this.deps.db.prepare('select path from transcript_files where session_id = ? and agent_id is null and device_id is null order by mtime desc limit 1').get(sessionId) as { path: string } | undefined;
    return f ? this.fileVersion(f.path) : null;
  }

  /** ファイルの版（平文の sha256 と大きさ）。無ければ null。 */
  private async fileVersion(file: string): Promise<{ sha256: string; size: number } | null> {
    let size: number;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return null;
      size = st.size;
    } catch {
      return null;
    }
    // 上げる側と同じく、stat した長さまでに限って読む（止めたあとなので伸びないはずだが、指紋と大きさを食い違わせない）。
    const sha256 = await sha256Stream(size === 0 ? Readable.from([]) : fs.createReadStream(file, { start: 0, end: size - 1 }));
    return { sha256, size };
  }

  /** 台帳（file_sync）にある、この PC の主線の本文の版。上げていなければ null。手元のファイルが無いときだけ使う。 */
  private transcriptVersion(provider: AgentKind, uuid: string): { sha256: string; size: number } | null {
    let key: string;
    try { key = ledgerKeyFor(provider, this.deps.deviceId, uuid, null); } catch { return null; }
    return (this.deps.db.prepare('select sha256, size from file_sync where key = ?').get(key) as { sha256: string; size: number } | undefined) ?? null;
  }
}
