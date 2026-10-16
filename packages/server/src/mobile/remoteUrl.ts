import { isRemoteControlUrl } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import type { Timers } from '../sync/engine.ts';

/** 画面を読む間隔。 */
export const REMOTE_URL_EVERY_MS = 2_000;
/** 起動からこの長さ読んで出なければ諦める。スマホは claude.ai/code を開く。 */
export const REMOTE_URL_FOR_MS = 60_000;

/**
 * claude を --remote-control で起こすと、見出しに出る URL（claude 2.1.301 の実物）。
 * `/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_…` の形で出る。
 */
const URL_RE = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/g;
const URL_HEAD = 'https://claude.ai/code/session_';
/** 折り返しの続きの行の頭として、URL の字だけを認める。字下げや罫線で始まる行は続きではない。 */
const URL_CHAR = /^[A-Za-z0-9:/._]/;

/** 末尾の語が、書きかけの URL（頭の途中か、session_ の後ろの英数字の途中）で終わっているか。 */
function endsInUrl(tail: string): boolean {
  for (let k = 0; k < tail.length; k++) {
    const s = tail.slice(k);
    if (URL_HEAD.startsWith(s)) return true;
    if (s.startsWith(URL_HEAD) && /^[A-Za-z0-9]*$/.test(s.slice(URL_HEAD.length))) return true;
  }
  return false;
}

/**
 * 端末の幅で折り返された URL をつなぐ。tmux は capture-pane -J でつないで返すが、psmux が -J を解するかは確かめていないので、自分でもつなぐ。
 * つなぐのは、行が幅いっぱいで（入力欄の罫線が幅いっぱいに引かれるので、いちばん長い行の長さを幅とみなす）、
 * その行の末尾の語が書きかけの URL で、次の行が行頭から URL の字で始まるときだけである。
 * URL の外で切れた行や、字下げで始まる行はつながない。
 */
function joinWrappedUrls(lines: string[]): string[] {
  const width = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    let last = line;
    // 末尾の語は、つないだ後の行で見る。3 行以上に折り返すと、真ん中の行は URL の頭を持たない。
    while (i + 1 < lines.length && last.length >= width && endsInUrl(/\S+$/.exec(line)?.[0] ?? '') && URL_CHAR.test(lines[i + 1]!)) {
      last = lines[++i]!;
      line += last;
    }
    out.push(line);
  }
  return out;
}

/**
 * 画面の文字から、Remote Control の URL を取り出す。無ければ null。
 * 画面にいくつもあれば、いちばん下（新しい）のものを返す。
 * claude.ai のものでなければ（isRemoteControlUrl を通らなければ）null。会話の文は攻撃者が操れるので、似せた行を通さない。
 */
export function extractRemoteUrl(screen: string): string | null {
  const lines = joinWrappedUrls(screen.replace(/\r\n/g, '\n').split('\n'));
  let found: string | null = null;
  for (const line of lines) for (const m of line.matchAll(URL_RE)) found = m[0];
  return found !== null && isRemoteControlUrl(found) ? found : null;
}

/**
 * 画面を everyMs ごとに読み、URL が出たら onFound を 1 回だけ呼んで止まる。forMs まで出なければ諦める。
 * 最初の読みは everyMs の後である（起こした直後は claude がまだ見出しを描いていない）。
 * 読めなかった回（画面がまだ無い、tmux が一瞬応えない）は投げずに次を待つ。
 * 返す関数で止める。何度呼んでもよい。
 */
export function watchRemoteUrl(o: { capture: () => string; onFound: (url: string) => void; timers: Pick<Timers, 'setInterval' | 'clearInterval'>; everyMs?: number; forMs?: number }): () => void {
  const every = o.everyMs ?? REMOTE_URL_EVERY_MS;
  const max = Math.max(1, Math.floor((o.forMs ?? REMOTE_URL_FOR_MS) / every));
  let reads = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer !== null) o.timers.clearInterval(timer);
    timer = null;
  };
  timer = o.timers.setInterval(() => {
    reads++;
    let url: string | null = null;
    try {
      url = extractRemoteUrl(o.capture());
    } catch {
      url = null;
    }
    if (url !== null) {
      stop();
      o.onFound(url);
      return;
    }
    if (reads >= max) stop();
  }, every);
  timer.unref?.();
  return stop;
}

/** 拾った URL を手元の表に残す。会話ごとに最新の 1 つで、同期しない。 */
export function saveRemoteUrl(db: Db, sessionId: string, url: string, at: number): void {
  db.prepare('insert into run_remote_urls (session_id, url, at) values (?, ?, ?) on conflict(session_id) do update set url = excluded.url, at = excluded.at').run(sessionId, url, at);
}
