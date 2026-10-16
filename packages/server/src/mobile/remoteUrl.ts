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
/** URL を出す見出しの行の目印。画面に URL がいくつもあれば、この行のものを先に採る。 */
const RC_LINE = '/remote-control is active';

/**
 * 末尾の語 tail が書きかけの URL で、次の行 next がその続きか。
 * 頭（https://claude.ai/code/session_）の途中で切れたなら、次の行は頭の残りで始まる（幅が狭ければ、行全体が頭の残りの途中まで）。
 * session_ の後ろの英数字で切れたなら、次の行は全体が英数字である。見出しの URL は行の末尾にあるので、続きの後ろに別の語は来ない。
 * `Tip: …` のように英数字で始まっても、ほかの字を含む行は続きではない。
 */
function continues(tail: string, next: string): boolean {
  const rest = next.trimEnd();
  if (rest === '') return false;
  for (let k = 0; k < tail.length; k++) {
    const s = tail.slice(k);
    if (s.length < URL_HEAD.length && URL_HEAD.startsWith(s)) {
      const left = URL_HEAD.slice(s.length);
      if (rest.startsWith(left) || left.startsWith(rest)) return true;
    }
    if (s.startsWith(URL_HEAD) && /^[A-Za-z0-9]*$/.test(s.slice(URL_HEAD.length)) && /^[A-Za-z0-9]+$/.test(rest)) return true;
  }
  return false;
}

/**
 * 端末の幅 width で折り返された URL をつなぐ。tmux は capture-pane -J でつないで返すので、ここを通るのは psmux（-J を受けてもつながない）と、-J を断る裏だけである。
 * つなぐのは、行の長さが端末の幅にちょうど等しく（折り返した行は幅いっぱいまで埋まる）、
 * つないだ後の末尾の語が書きかけの URL で、次の行がその続き（continues）のときだけである。
 */
function joinWrappedUrls(lines: string[], width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    let last = line;
    // 末尾の語は、つないだ後の行で見る。3 行以上に折り返すと、真ん中の行は URL の頭を持たない。
    while (i + 1 < lines.length && last.length === width && continues(/\S+$/.exec(line)?.[0] ?? '', lines[i + 1]!)) {
      last = lines[++i]!;
      line += last;
    }
    out.push(line);
  }
  return out;
}

/**
 * 画面の文字から、Remote Control の URL を取り出す。無ければ null。
 * wrapWidth は、画面がまだ端末の幅で折り返されているときのその幅である。渡したときだけ、URL の中で切れた行をつなぐ。
 * 折り返しをつないだ画面（tmux の -J）では渡さない。つないだ行は端末の幅より長く、幅を見誤ると URL の後ろの行まで飲み込む。
 * `/remote-control is active` の行に URL があれば、そのいちばん下のものを返す。無ければ画面のいちばん下のもの。
 * claude.ai のものでなければ（isRemoteControlUrl を通らなければ）null。会話の文は攻撃者が操れるので、似せた行を通さない。
 */
export function extractRemoteUrl(screen: string, wrapWidth: number | null = null): string | null {
  const raw = screen.replace(/\r\n/g, '\n').split('\n');
  const lines = wrapWidth !== null && wrapWidth > 0 ? joinWrappedUrls(raw, wrapWidth) : raw;
  let found: string | null = null;
  let onRcLine: string | null = null;
  for (const line of lines) {
    for (const m of line.matchAll(URL_RE)) {
      found = m[0];
      if (line.includes(RC_LINE)) onRcLine = m[0];
    }
  }
  const url = onRcLine ?? found;
  return url !== null && isRemoteControlUrl(url) ? url : null;
}

/** 画面の文字と、まだ折り返されているならその幅（PaneOps.captureUnwrapped）。 */
export type PaneScreen = { text: string; width: number | null };

/**
 * 画面を everyMs ごとに読み（capture は折り返しをつないだ画面か、折り返したままの画面とその幅を返す）、URL が出たら onFound を 1 回だけ呼んで止まる。forMs まで出なければ諦める。
 * 最初の読みは everyMs の後である（起こした直後は claude がまだ見出しを描いていない）。
 * 読めなかった回（画面がまだ無い、tmux が一瞬応えない）は投げずに次を待つ。
 * 返す関数で止める。何度呼んでもよい。
 */
export function watchRemoteUrl(o: { capture: () => PaneScreen; onFound: (url: string) => void; timers: Pick<Timers, 'setInterval' | 'clearInterval'>; everyMs?: number; forMs?: number }): () => void {
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
      const screen = o.capture();
      url = extractRemoteUrl(screen.text, screen.width);
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
