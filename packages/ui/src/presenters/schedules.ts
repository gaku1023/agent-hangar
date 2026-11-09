import { eventsAvailable, EVENT_HOURLY_MAX, type EventAction, type EventBindingDto, type EventBindingState, type GithubWhen, type PrClaimDto, type ScheduleDto, type ScheduleRunResult, type ScheduleSpec, type ScheduleTarget, type Translate } from '@agent-hangar/shared';
import type { EventNotice, Store } from '../store/store.ts';
import { PERMISSION_BYPASS, permissionLabel } from '../views/primitives/permissionModel.ts';
import { durationLabel } from './format.ts';
import { presentLaunchChoice, type LaunchChoiceData } from './newSession.ts';

export type ScheduleRunRow = { id: string; result: ScheduleRunResult; label: string; sessionId: string | null; title: string | null; took: string | null; at: string };
/** 保存した起動設定の 1 項目（読み取り専用の札）。danger は確認なしに動く設定（Bypass permissions、full-access、自動承認）。 */
export type ScheduleLaunchChip = { name: string; value: string; danger?: boolean; suffix?: string };
export type ScheduleRow = {
  id: string; prompt: string; when: string; next: string; enabled: boolean; dest: string;
  spec: ScheduleSpec; target: ScheduleTarget; runs: ScheduleRunRow[];
  /** 新しい会話の予定が保存している起動設定。未指定の項目は含めない。 */
  chips: ScheduleLaunchChip[];
  /** 1 回だけの予定で、もう流れたものは再開できない。 */
  spent: boolean;
};
/** 外のできごとで動く結び付けの 1 行（#563）。下書き（承認待ち）も同じ形で、pending が真。 */
export type EventRow = {
  id: string; prompt: string; state: EventBindingState; pending: boolean; held: boolean;
  /** 元の言い方（GitHub と repo、または webhook）。 */
  source: string;
  sourceKind: 'github' | 'hook';
  /** GitHub の repo。外の webhook は null。 */
  repo: string | null;
  /** 見るできごと（CI 完了、マージなど）を読点でつないだもの。外の webhook は空。 */
  when: string;
  /** PR の番号と札の絞り込み。無ければ空。 */
  filters: string[];
  /** 動き。送り先の会話が分かれば、その名前を添える。 */
  action: string;
  /** 新しい会話の起動設定。承認の前に見えるよう、行が閉じていても出す（danger は確認なしに動く設定）。 */
  chips: ScheduleLaunchChip[];
  passBody: boolean; allowAuthors: string[];
  /** 止めた理由の一文（held のとき）。 */
  note: string | null;
  runs: ScheduleRunRow[];
};
/** 担当する PR の印の下書きの 1 行。 */
export type PrClaimRow = { key: string; sessionId: string; repo: string; pr: number; text: string };
export type EventsProps = {
  /** 承認待ちの下書き（MCP から）。 */
  drafts: EventRow[];
  claims: PrClaimRow[];
  rows: EventRow[];
  /** 作成の送信の状態。done は作れた回数で、増えたらフォームを閉じる。 */
  form: { busy: boolean; error: string | null; done: number };
  /** 承認や削除の失敗の一文。 */
  error: string | null;
  /** 一覧が変わった読み直しと、操作が済むたびに増える番号（repo の札が状態を取り直す合図）。 */
  rev: number;
};
export type SchedulesProps = {
  rows: ScheduleRow[];
  /** イベントの節。クラウドを設定していない、Worker の版が足りないなど、使えないときは null で、画面は節ごと出さない。 */
  events: EventsProps | null;
  sessions: { id: string; name: string }[];
  /** プロジェクトの札とエージェント、アカウントの札の中身（新しいセッションのダイアログと同じ）。前回値は持ち込まない。 */
  launch: LaunchChoiceData;
};

const CODEX_PERMISSION_LABEL = { 'read-only': 'launch.codexPermission.readOnly', auto: 'launch.codexPermission.auto', 'full-access': 'launch.codexPermission.fullAccess' } as const;

/** 保存した起動設定を、詳細の札の並びにする。値の無い項目は出さない。 */
export function launchChips(t: Translate, target: Extract<ScheduleTarget, { kind: 'new' }>, accountName: string | null): ScheduleLaunchChip[] {
  const out: ScheduleLaunchChip[] = [];
  const codex = target.agent === 'codex';
  if (target.account) out.push({ name: t('launch.chip.account'), value: accountName ?? target.account });
  if (target.mode) out.push({ name: t('launch.chip.mode'), value: target.mode });
  if (target.model) out.push({ name: t('launch.chip.model'), value: target.model });
  if (target.effort) out.push({ name: t(codex ? 'launch.chip.reasoning' : 'launch.chip.effort'), value: target.effort });
  if (target.permissionMode) {
    if (codex) {
      const key = CODEX_PERMISSION_LABEL[target.permissionMode as keyof typeof CODEX_PERMISSION_LABEL];
      out.push({ name: t('launch.chip.codexPermission'), value: key ? t(key) : target.permissionMode, ...(target.permissionMode === 'full-access' ? { danger: true } : {}) });
    } else out.push({ name: t('launch.permission.label'), value: permissionLabel(target.permissionMode, t), ...(target.permissionMode === PERMISSION_BYPASS ? { danger: true } : {}) });
  }
  if (target.autoApprove) out.push({ name: t('launch.chip.autoApprove'), value: t('launch.autoApprove.on'), danger: true });
  if (target.worktree) out.push({ name: t('launch.chip.worktree'), value: target.worktree, suffix: t('schedules.worktree.suffix') });
  if (target.addDirs?.length) out.push({ name: t('launch.chip.addDirs'), value: t('launch.value.dirCount', { n: target.addDirs.length }) });
  if (target.name) out.push({ name: t('launch.chip.name'), value: target.name });
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');
const hm = (ms: number) => { const d = new Date(ms); return `${d.getHours()}:${pad(d.getMinutes())}`; };
const shortTime = (time: string) => time.replace(/^0/, '');
const dayOf = (t: Translate, d: number) => t(`schedules.day.d${d}` as 'schedules.day.d0');
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

function monthDay(t: Translate, ms: number): string {
  const d = new Date(ms);
  return t('schedules.format.date', { month: d.getMonth() + 1, day: d.getDate(), weekday: dayOf(t, d.getDay()) });
}

/** 繰り返しの言い方。 */
export function whenLabel(t: Translate, spec: ScheduleSpec): string {
  switch (spec.kind) {
    case 'once': return `${monthDay(t, spec.at)} ${hm(spec.at)}`;
    case 'every': return t('schedules.when.every', { n: spec.minutes });
    case 'weekly': {
      const time = shortTime(spec.time);
      if (spec.days.length === 7) return t('schedules.when.daily', { time });
      if (spec.days.length === 5 && spec.days.every((d) => d >= 1 && d <= 5)) return t('schedules.when.weekdays', { time });
      // 月曜を頭に並べる。
      const days = [...spec.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => dayOf(t, d)).join(t('schedules.day.sep'));
      return `${days} ${time}`;
    }
  }
}

/** 次の時刻。今日、明日、それより先で言い分ける。 */
export function nextLabel(t: Translate, at: number | null, now: number): string {
  if (at === null) return '';
  if (sameDay(at, now)) return t('schedules.next.today', { time: hm(at) });
  if (sameDay(at, now + 86_400_000)) return t('schedules.next.tomorrow', { time: hm(at) });
  return `${monthDay(t, at)} ${hm(at)}`;
}

function runRow(t: Translate, r: ScheduleDto['runs'][number], now: number): ScheduleRunRow {
  return {
    id: r.id, result: r.result, label: t(`schedules.result.${r.result}` as 'schedules.result.finished'),
    sessionId: r.sessionId, title: r.sessionTitle,
    took: r.endedAt !== null && r.result !== 'skipped' ? durationLabel(t, r.endedAt - r.startedAt) : null,
    at: sameDay(r.startedAt, now) ? hm(r.startedAt) : `${monthDay(t, r.startedAt)} ${hm(r.startedAt)}`,
  };
}

const WHEN_KEY = { ci_done: 'schedules.event.when.ciDone', ci_failed: 'schedules.event.when.ciFailed', review: 'schedules.event.when.review', comment: 'schedules.event.when.comment', merged: 'schedules.event.when.merged', issue_opened: 'schedules.event.when.issueOpened' } as const satisfies Record<GithubWhen, string>;
/** GitHub で見るできごとの言い方（決めた文面 w12）。 */
export const githubWhenLabel = (t: Translate, w: GithubWhen): string => t(WHEN_KEY[w]);

/** 履歴の error に入る印を、決めた言い方にする。知らない印は null で、ふつうの結果の言い方のまま。 */
export function eventMarker(t: Translate, error: string | null): string | null {
  if (!error) return null;
  const rejected = /^rejected:(signature|unparsable) x(\d+)$/.exec(error);
  if (rejected) return t(rejected[1] === 'signature' ? 'schedules.event.history.badSignature' : 'schedules.event.history.unreadable', { n: Number(rejected[2]) });
  const dropped = /^dropped:(\d+)$/.exec(error);
  if (dropped) return t('schedules.event.history.overLimit', { n: Number(dropped[1]) });
  if (error === 'no_destination') return t('schedules.event.history.noDestination');
  if (error === 'held:hourly') return t('schedules.event.heldHourly', { max: EVENT_HOURLY_MAX });
  return null;
}

function actionLabel(t: Translate, store: Store, a: EventAction): string {
  const key = ({ wake: 'schedules.event.action.wake', send: 'schedules.event.action.send', send_pr_owner: 'schedules.event.action.sendPrOwner', new: 'schedules.event.action.new' } as const)[a.kind];
  const session = a.kind === 'send' || a.kind === 'wake' ? store.sessions[a.sessionId] : undefined;
  const name = session ? session.name || session.summary?.title || '' : '';
  return name ? `${t(key)} · ${name}` : t(key);
}

/**
 * 新しい会話の動きの札。どこで何が動くかが承認の前に見えるよう、プロジェクト（クイックセッションはその名前）とエージェントを頭に置く。
 * アカウントは、ストアに名前があればその名前、無ければ id のまま出す（launchChips）。
 */
function newActionChips(store: Store, t: Translate, a: Extract<EventAction, { kind: 'new' }>): ScheduleLaunchChip[] {
  const project = a.projectId === null || a.scratch === true ? t('schedules.list.quick') : store.projects[a.projectId]?.name ?? a.projectId;
  const agent = a.agent ?? 'claude-code';
  const pool = agent === 'codex' ? store.accounts?.codex?.accounts : agent === 'claude-code' ? store.accounts?.accounts : undefined;
  const accountName = a.account ? pool?.find((x) => x.id === a.account)?.name ?? null : null;
  return [{ name: t('schedules.form.project'), value: project }, { name: t('launch.chip.agent'), value: agentLabel(agent) }, ...launchChips(t, a, accountName)];
}

function eventRow(store: Store, t: Translate, now: number, b: EventBindingDto): EventRow {
  const gh = b.source.kind === 'github' ? b.source : null;
  return {
    id: b.id, prompt: b.prompt, state: b.state, pending: b.state === 'draft', held: b.state === 'held',
    source: gh ? `${t('schedules.event.kind.github')} · ${gh.repo}` : t('schedules.event.kind.hook'),
    sourceKind: gh ? 'github' : 'hook', repo: gh ? gh.repo : null,
    when: gh ? gh.when.map((w) => githubWhenLabel(t, w)).join(t('schedules.event.when.sep')) : '',
    filters: gh ? [...(gh.pr !== undefined ? [`#${gh.pr}`] : []), ...(gh.labels ?? [])] : [],
    action: actionLabel(t, store, b.action),
    chips: b.action.kind === 'new' ? newActionChips(store, t, b.action) : [],
    passBody: b.passBody, allowAuthors: b.allowAuthors,
    note: b.state === 'held' ? t('schedules.event.heldHourly', { max: EVENT_HOURLY_MAX }) : null,
    runs: b.runs.map((r) => {
      const base = runRow(t, r, now);
      const marker = eventMarker(t, r.error);
      return marker ? { ...base, label: marker } : base;
    }),
  };
}

const noticeText = (t: Translate, n: EventNotice | null): string | null => (n === null ? null : n.kind === 'no_admin' ? t('schedules.event.noAdmin') : n.kind === 'hook_failed' ? t('schedules.event.hookFailed') : n.text);
const claimRow = (t: Translate, c: PrClaimDto): PrClaimRow => ({ key: `${c.sessionId}#${c.repo}#${c.pr}`, sessionId: c.sessionId, repo: c.repo, pr: c.pr, text: t('schedules.event.claim', { title: c.sessionTitle || c.sessionId, repo: c.repo, pr: c.pr }) });

function presentEvents(store: Store, t: Translate, now: number): EventsProps | null {
  if (!eventsAvailable(store.sync)) return null;
  const e = store.eventTrigger;
  const rows = e.bindings.map((b) => eventRow(store, t, now, b));
  return {
    drafts: rows.filter((r) => r.pending), rows: rows.filter((r) => !r.pending), claims: e.claims.map((c) => claimRow(t, c)),
    form: { busy: e.form.busy, error: noticeText(t, e.form.error), done: e.form.done }, error: noticeText(t, e.error), rev: e.rev,
  };
}

export function presentSchedules(store: Store, t: Translate, now: number): SchedulesProps {
  const rows = store.schedules.map((s): ScheduleRow => ({
    id: s.id, prompt: s.prompt, when: whenLabel(t, s.spec), next: nextLabel(t, s.nextAt, now), enabled: s.enabled,
    // クイックセッションの予定はプロジェクトを持たないので、プロジェクト名の代わりにその名前を出す。
    dest: s.target.kind === 'session' ? s.sessionTitle ?? '' : [s.target.projectId === null ? t('schedules.list.quick') : s.projectName, s.target.agent ? agentLabel(s.target.agent) : null].filter(Boolean).join(' · '),
    spec: s.spec, target: s.target, runs: s.runs.map((r) => runRow(t, r, now)),
    chips: s.target.kind === 'new' ? launchChips(t, s.target, s.accountName) : [],
    spent: s.spec.kind === 'once' && s.spec.at <= now,
  }));
  return {
    rows, events: presentEvents(store, t, now),
    sessions: Object.values(store.sessions).filter((s) => s.projectId !== null).sort((a, b) => (b.lastTurnAt ?? 0) - (a.lastTurnAt ?? 0)).slice(0, 50).map((s) => ({ id: s.id, name: s.name || s.summary?.title || s.id })),
    launch: presentLaunchChoice(store, now, {}, null),
  };
}

const LABELS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'opencode' };
const agentLabel = (a: string): string => LABELS[a] ?? a;
