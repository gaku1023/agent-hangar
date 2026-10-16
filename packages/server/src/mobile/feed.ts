import { addDays, clampText, isRemoteControlUrl, localDate, PRIMARY_ACCOUNT_ID, type LiveSessionDto, type MobileAccount, type MobileCaps, type MobileDoneItem, type MobileFeed, type MobileLiveItem, type MobileProject, type MobileReturnItem, type MobileWaiting, type UsageDto } from '@agent-hangar/shared';
import type { Account } from '../config/accounts.ts';
import { accountOfSession, displayName } from '../db/queries.ts';
import type { Db } from '../db/open.ts';
import { latestIntent } from '../live/intents.ts';
import { readEvents } from '../transcript/read.ts';

/** Done を受信箱に残す長さ。「今日」の絞り込みはスマホが自分の日付でするので、PC は少し広めに入れる。 */
export const DONE_WINDOW_MS = 36 * 3_600_000;

export type FeedSources = {
  db: Db;
  deviceId: string;
  deviceName: string;
  live: LiveSessionDto[];
  accounts: Account[];
  usageOf: (accountId: string) => UsageDto | null;
  now: number;
  /** 「明日」を決める暦のタイムゾーン（IANA 名）。省略すると、この PC の手元の暦。 */
  tz?: string;
};

type SessionRow = {
  id: string;
  project_id: string | null;
  project_name: string | null;
  custom_title: string | null;
  note_name: string | null;
  ai_title: string | null;
  first_prompt: string | null;
};
type LastRun = { id: string; device_id: string; started_at: number; ended_at: number | null };

// session_notes と projects は主キーで引く。sessions は (provider, provider_session_id) の一意索引か主キーで引く。
const SESSION_COLS = `s.id, s.project_id, p.name project_name, s.custom_title, n.name note_name, s.ai_title, s.first_prompt
  from sessions s
  left join projects p on p.id = s.project_id and p.deleted_at is null
  left join session_notes n on n.session_id = s.id and n.deleted_at is null`;

/** 会話の最後の run。runs_session_started（session_id, started_at）の索引で 1 行だけ引く。 */
function lastRunOf(db: Db, sessionId: string): LastRun | null {
  return (db.prepare('select id, device_id, started_at, ended_at from runs where session_id = ? and deleted_at is null order by started_at desc, id desc limit 1').get(sessionId) as LastRun | undefined) ?? null;
}

function titleOf(s: SessionRow, live?: LiveSessionDto): string {
  return displayName({ custom_title: s.custom_title, name: s.note_name, ai_title: s.ai_title, first_prompt: s.first_prompt }, live) ?? '';
}

/** tz の暦の日付（YYYY-MM-DD）。tz が無ければ手元の暦。 */
function dateIn(now: number, tz: string | undefined): string {
  if (!tz) return localDate(now);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * 入力待ちの中身。待っていなければ null。問いの文は session_activity、許可の中身は登録の permission から取る。
 * 画面の札（ui の presenters/live.ts の staleWait、shared の stopReasonOf）と同じく、今の待ちに合わない中身は出さない。
 * 許可の待ちでは、前の AskUserQuestion の問いが残っていても許可の中身を出す。
 * 問いの待ちでは、AskUserQuestion でない許可の中身を問いとして出さない。
 * Claude Code の版によっては AskUserQuestion の待ちに permission を書くので、許可の中身が AskUserQuestion なら問いとして扱う。
 * 許可でない待ち（other）で、最後の呼び出しにもう答えが出ていれば、その問いは済んだものなので出さない（staleWait）。
 */
function waitingOf(db: Db, sessionId: string, live: LiveSessionDto): MobileWaiting | null {
  if (live.status !== 'waiting') return null;
  const act = db.prepare('select tool, tool_id, question from session_activity where session_id = ?').get(sessionId) as { tool: string; tool_id: string; question: string | null } | undefined;
  const asked = act?.tool === 'AskUserQuestion' && act.question ? act.question : null;
  const question = asked !== null && live.waitingFor === 'other' && answered(db, sessionId, act!.tool_id) ? null : asked;
  const p = live.permission;
  const asking = live.waitingFor === 'question' || p?.tool === 'AskUserQuestion';
  if (asking) return { kind: 'question', text: clampText(question) ?? '' };
  if (p) {
    const body = p.input.trim() || (p.description ?? '').trim();
    return { kind: live.waitingFor ?? 'permission', text: clampText(body ? `${p.tool}: ${body}` : p.tool) ?? '' };
  }
  if (question) return { kind: 'question', text: clampText(question) ?? '' };
  return { kind: live.waitingFor ?? 'other', text: '' };
}

/** 答えを探す主線の末尾の長さ。問いを待つ間は後ろに出来事が続かないので、答えがあればこの中にある。 */
const ANSWER_TAIL = 40;

/**
 * 呼び出し toolId に答え（tool_result）が出ているか。画面の札（presenters/live.ts の staleWait）が本文の出来事で見るのと同じものを、主線の末尾だけ読んで見る。
 * 読むのは索引で位置を引いた末尾の数件で、許可でない待ちの会話のときだけである。本文が無い、読めないときは、答えは無いものとする。
 */
function answered(db: Db, sessionId: string, toolId: string): boolean {
  try {
    return readEvents(db, sessionId, { latest: true, limit: ANSWER_TAIL }).events.some((e) => e.kind === 'tool_result' && e.toolId === toolId);
  } catch {
    return false;
  }
}

/**
 * Remote Control の URL（mobile/remoteUrl.ts が画面から拾ったもの）。今の run の起動より後に拾ったものだけを使う。
 * 前の run の URL は、その claude が終わった今はつながらない。claude.ai のものでなければ出さない。
 */
function rcUrlOf(db: Db, sessionId: string, runStartedAt: number): string | null {
  const row = db.prepare('select url from run_remote_urls where session_id = ? and at >= ?').get(sessionId, runStartedAt) as { url: string } | undefined;
  return row && isRemoteControlUrl(row.url) ? row.url : null;
}

/**
 * この PC に場所のあるプロジェクトごとの、最後の run の開始時刻。1 回の集計で引く。
 * project_roots（小さい表）から、sessions_project（project_id）と runs_session_started（session_id, started_at）の索引で辿る。
 * cross join で辿る順を固定する。並べ替えのために sessions を索引ごと全部なめる計画を選ばせない。
 */
export const LAST_USED_SQL = `select s.project_id id, max(r.started_at) at
  from project_roots pr
  cross join sessions s on s.project_id = pr.project_id and s.deleted_at is null
  cross join runs r on r.session_id = s.id and r.deleted_at is null
  where pr.device_id = ? and pr.deleted_at is null and pr.resolved = 1
  group by s.project_id`;

/**
 * 受信箱の素を、手元の DB と実行中の状態から組む。純粋な関数で、同じ入力からは同じ JSON になる。
 * 引くのは索引のある列だけで、events のような大きい表は読まない。本文は、許可でない待ちの会話の末尾の数件だけを読む（answered）。
 * session_states には status の索引が無いが、行は状態を付けた会話だけで小さい。
 */
/** この版の hangar ができること。スマホは、これの無い（rc.1 の）PC に画像、effort、候補を出さない。 */
export const FEED_CAPS: MobileCaps = { asks: true, images: true, effort: true };

export function buildMobileFeed(src: FeedSources): MobileFeed {
  const { db, deviceId, now } = src;
  const accountOf = (sessionId: string): string => accountOfSession(db, sessionId, deviceId) ?? PRIMARY_ACCOUNT_ID;

  // live: 登録の会話から、sessions と最後の run を索引で引いて、この PC で終わっていない run のものだけ残す。
  const liveItems: MobileLiveItem[] = [];
  const liveIds = new Set<string>();
  for (const l of src.live) {
    const s = db.prepare(`select ${SESSION_COLS} where s.provider = 'claude-code' and s.provider_session_id = ? and s.deleted_at is null`).get(l.sessionId) as SessionRow | undefined;
    if (!s || liveIds.has(s.id)) continue;
    const r = lastRunOf(db, s.id);
    if (!r || r.device_id !== deviceId || r.ended_at !== null) continue;
    liveIds.add(s.id);
    liveItems.push({
      sessionId: s.id,
      projectId: s.project_id,
      projectName: s.project_name ?? '',
      title: titleOf(s, l),
      accountId: accountOf(s.id),
      status: l.status,
      statusAt: l.statusAt ?? r.started_at,
      startedAt: r.started_at,
      waiting: waitingOf(db, s.id, l),
      intent: clampText(latestIntent(db, s.id)?.text),
      rcUrl: rcUrlOf(db, s.id, r.started_at),
    });
  }
  liveItems.sort((a, b) => b.statusAt - a.statusAt || a.sessionId.localeCompare(b.sessionId));

  // returns と done: 状態を付けた会話を引き、最後の run がこの PC のものだけ残す。
  const tomorrow = addDays(dateIn(now, src.tz), 1);
  const pausedRows = db
    .prepare("select session_id, return_on, return_time from session_states where deleted_at is null and status = 'paused' and return_on is not null and return_on <= ?")
    .all(tomorrow) as { session_id: string; return_on: string; return_time: string | null }[];
  const doneRows = db
    .prepare("select session_id, set_at from session_states where deleted_at is null and status = 'done' and set_at >= ?")
    .all(now - DONE_WINDOW_MS) as { session_id: string; set_at: number }[];

  const mine = (sessionId: string): SessionRow | null => {
    if (liveIds.has(sessionId)) return null;
    const s = db.prepare(`select ${SESSION_COLS} where s.id = ? and s.deleted_at is null`).get(sessionId) as SessionRow | undefined;
    if (!s) return null;
    return lastRunOf(db, s.id)?.device_id === deviceId ? s : null;
  };

  const returns: MobileReturnItem[] = [];
  for (const r of pausedRows) {
    const s = mine(r.session_id);
    if (s) returns.push({ sessionId: s.id, projectName: s.project_name ?? '', title: titleOf(s), accountId: accountOf(s.id), returnOn: r.return_on, returnTime: r.return_time });
  }
  const key = (r: MobileReturnItem): string => `${r.returnOn} ${r.returnTime ?? ''}`;
  returns.sort((a, b) => key(b).localeCompare(key(a)) || a.sessionId.localeCompare(b.sessionId));

  const done: MobileDoneItem[] = [];
  for (const r of doneRows) {
    const s = mine(r.session_id);
    if (!s) continue;
    const sum = db.prepare('select one_liner from session_summaries where session_id = ? and deleted_at is null').get(s.id) as { one_liner: string } | undefined;
    done.push({ sessionId: s.id, projectName: s.project_name ?? '', title: titleOf(s), oneLiner: clampText(sum?.one_liner), doneAt: r.set_at });
  }
  done.sort((a, b) => b.doneAt - a.doneAt || a.sessionId.localeCompare(b.sessionId));

  // projects: この PC に場所のある（未解決でない）プロジェクト。project_roots は小さい表で、device_id の索引は無い。
  const projectRows = db
    .prepare('select p.id, p.name from project_roots r join projects p on p.id = r.project_id where r.device_id = ? and r.deleted_at is null and r.resolved = 1 and p.deleted_at is null and p.is_scratch = 0')
    .all(deviceId) as { id: string; name: string }[];
  const lastUsed = new Map((db.prepare(LAST_USED_SQL).all(deviceId) as { id: string; at: number }[]).map((r) => [r.id, r.at]));
  const projects: MobileProject[] = projectRows.map((p) => ({ id: p.id, name: p.name, lastUsedAt: lastUsed.get(p.id) ?? null }));
  projects.sort((a, b) => (b.lastUsedAt ?? -Infinity) - (a.lastUsedAt ?? -Infinity) || a.id.localeCompare(b.id));

  const accounts: MobileAccount[] = src.accounts.map((a) => {
    const u = src.usageOf(a.id);
    return { id: a.id, name: a.name, color: a.color, fiveHour: u?.fiveHour?.usedPercent ?? null, sevenDay: u?.sevenDay?.usedPercent ?? null };
  });

  return { v: 1, deviceId, deviceName: src.deviceName, caps: FEED_CAPS, accounts, projects, live: liveItems, returns, done };
}
