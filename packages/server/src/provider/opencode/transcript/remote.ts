import fs from 'node:fs';
import path from 'node:path';
import { isSafeKeyId } from '@agent-hangar/shared';
import type { TranscriptSink, TranscriptSource } from '../../../agent/types.ts';
import type { Db } from '../../../db/open.ts';
import { readStoredPage } from '../../../transcript/stored.ts';
import { convertMessages, settledCount } from './convert.ts';

/**
 * ほかの PC から降ろした opencode の本文の写しを、閲覧のために索引へ入れる面（docs/design.md「opencode の本文の同期」）。
 *
 * 写しは同期の puller が `~/.agent-hangar/remote/<元の PC>/opencode/<会話>.json` に置く export の JSON（info と、古い順の messages）である。
 * 手元の会話と同じ変換（convert.ts の convertMessages）に通し、作り直しの束（reset）として sink に渡す。読む側は手元の会話と同じ transcript/stored.ts である。
 * 束には元の PC（remoteDevice）を付ける。索引は他端末の写しとして書く（会話の行には書かず、行がまだ届いていなければ書かない）。
 *
 * 見る契機は、索引が始まったときと refresh（写しが降りたときと、会話の行が届いたとき。boot/indexing.ts）である。
 * 同じ会話の写しが何台分もあれば、本文のいちばん新しいものを選ぶ。
 * この PC で動いている会話と、この PC の書き出し（`opencode/export/<会話>.json`）の方が新しい会話には入れない（手元の写しの面が受け持つ）。
 * どの写しを入れたかの印（写しの大きさと更新時刻）は marks に残し、変わっていなければ読み直さない。印は hangar を起こし直しても残す（sync_state）。
 */

export type RemoteOpencodeOptions = {
  db: Db;
  /** ほかの PC から降ろした本文の置き場（`~/.agent-hangar/remote`）。 */
  remoteRoot: string;
  /** この PC の書き出しの置き場（`~/.agent-hangar/opencode/export`）。 */
  exportDir: string;
  /** 会話ごとの、入れた写しの印。 */
  marks: { get(providerSessionId: string): string | null; set(providerSessionId: string, value: string | null): void };
  /** その会話がこの PC で動いているか。 */
  isRunningHere: (providerSessionId: string) => boolean;
  log?: (line: string) => void;
};

type Copy = { device: string; file: string; size: number; mtimeMs: number };
type Parsed = { directory: string | null; messages: unknown[]; last: number };

const NAME_RE = /^(.+)\.json$/;
const SAFE_DEVICE = /^[A-Za-z0-9._-]+$/;

/** export の JSON を読む。本文のいちばん新しい時刻（info.time.updated とメッセージの時刻の最大）も求める。読めなければ null。 */
function parseExport(file: string): Parsed | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as { info?: { time?: { updated?: unknown }; location?: { directory?: unknown } }; messages?: unknown };
    if (!Array.isArray(v.messages)) return null;
    let last = typeof v.info?.time?.updated === 'number' ? v.info.time.updated : 0;
    for (const m of v.messages) {
      const t = (m as { time?: { created?: unknown; completed?: unknown } } | null)?.time;
      for (const x of [t?.created, t?.completed]) if (typeof x === 'number' && x > last) last = x;
    }
    const dir = v.info?.location?.directory;
    return { directory: typeof dir === 'string' && dir !== '' ? dir : null, messages: v.messages, last };
  } catch {
    return null;
  }
}

export class RemoteOpencodeTranscripts implements TranscriptSource {
  readonly readPage = readStoredPage;
  private sink: TranscriptSink | null = null;

  constructor(private readonly o: RemoteOpencodeOptions) {}

  start(sink: TranscriptSink): void {
    this.sink = sink;
    this.refresh();
  }

  stop(): void {
    this.sink = null;
  }

  /** 写しを見直し、変わった会話を入れる。入れた会話の数を返す。索引が始まる前は何もしない。 */
  refresh(): number {
    if (!this.sink) return 0;
    let n = 0;
    for (const [id, copies] of this.copies()) {
      try {
        if (this.apply(id, copies)) n++;
      } catch (e) {
        (this.o.log ?? ((l: string) => { console.warn(l); }))(`[opencode] could not read a transcript from another PC: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return n;
  }

  /** 置き場にある写しを、会話ごとにまとめる。リンクと、形の違う名前は読まない。 */
  private copies(): Map<string, Copy[]> {
    const out = new Map<string, Copy[]>();
    let devices: fs.Dirent[];
    try { devices = fs.readdirSync(this.o.remoteRoot, { withFileTypes: true }); } catch { return out; }
    for (const d of devices) {
      if (!d.isDirectory() || !SAFE_DEVICE.test(d.name) || d.name === '.' || d.name === '..') continue;
      const folder = path.join(this.o.remoteRoot, d.name, 'opencode');
      let names: fs.Dirent[];
      try { names = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
      for (const f of names) {
        const m = NAME_RE.exec(f.name);
        if (!f.isFile() || !m || !isSafeKeyId(m[1]!)) continue;
        const file = path.join(folder, f.name);
        let st: fs.Stats;
        try { st = fs.lstatSync(file); } catch { continue; }
        if (!st.isFile()) continue;
        const list = out.get(m[1]!) ?? [];
        list.push({ device: d.name, file, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
        out.set(m[1]!, list);
      }
    }
    return out;
  }

  private apply(id: string, copies: Copy[]): boolean {
    const mark = copies.map((c) => `${c.device}:${c.size}:${c.mtimeMs}`).sort().join('|');
    // 会話の行が届いていない（または消した）なら、まだ入れない。印も付けず、行が届いた後の refresh で入れる。
    const row = this.o.db.prepare("select id from sessions where provider = 'opencode' and provider_session_id = ? and deleted_at is null").get(id) as { id: string } | undefined;
    if (!row) return false;
    // 同じ写しを入れてあれば読み直さない。ただし索引の本文が消えていれば（ゴミ箱から戻した会話など）入れ直す。
    if (this.o.marks.get(id) === mark && this.o.db.prepare("select 1 from agent_events where session_id = ? and agent_key = '' limit 1").get(row.id)) return false;
    // この PC で動いている会話は、手元の写しの面が受け持つ。止まった後に見直せるよう、印は付けない。
    if (this.o.isRunningHere(id)) return false;
    let best: { copy: Copy; parsed: Parsed } | null = null;
    for (const c of copies) {
      const parsed = parseExport(c.file);
      if (parsed && (!best || parsed.last > best.parsed.last)) best = { copy: c, parsed };
    }
    if (!best) return false;
    const local = parseExport(path.join(this.o.exportDir, `${id}.json`));
    if (local && local.last >= best.parsed.last) {
      this.o.marks.set(id, mark);
      return false;
    }
    const sink = this.sink;
    if (!sink) return false;
    const take = best.parsed.messages.slice(0, settledCount(best.parsed.messages));
    sink.batch({
      agent: 'opencode', providerSessionId: id, agentId: null, reset: true,
      ...(best.parsed.directory ? { cwd: best.parsed.directory } : {}),
      records: convertMessages(take),
      remoteDevice: best.copy.device,
    });
    this.o.marks.set(id, mark);
    return true;
  }
}
