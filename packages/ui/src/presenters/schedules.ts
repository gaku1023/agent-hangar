import { codexEnabledOf, opencodeEnabledOf, type ScheduleDto, type ScheduleRunResult, type ScheduleSpec, type ScheduleTarget, type Translate } from '@agent-hangar/shared';
import type { Store } from '../store/store.ts';
import { durationLabel } from './format.ts';

export type ScheduleRunRow = { id: string; result: ScheduleRunResult; label: string; sessionId: string | null; title: string | null; took: string | null; at: string };
export type ScheduleRow = {
  id: string; prompt: string; when: string; next: string; enabled: boolean; dest: string;
  spec: ScheduleSpec; target: ScheduleTarget; runs: ScheduleRunRow[];
  /** 1 回だけの予定で、もう流れたものは再開できない。 */
  spent: boolean;
};
export type SchedulesProps = {
  rows: ScheduleRow[];
  projects: { id: string; name: string }[];
  sessions: { id: string; name: string }[];
  agents: { id: string; label: string }[];
};

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

export function presentSchedules(store: Pick<Store, 'schedules' | 'projects' | 'sessions' | 'settings'>, t: Translate, now: number): SchedulesProps {
  const rows = store.schedules.map((s): ScheduleRow => ({
    id: s.id, prompt: s.prompt, when: whenLabel(t, s.spec), next: nextLabel(t, s.nextAt, now), enabled: s.enabled,
    dest: s.target.kind === 'session' ? s.sessionTitle ?? '' : [s.projectName, s.target.agent ? agentLabel(s.target.agent) : null].filter(Boolean).join(' · '),
    spec: s.spec, target: s.target, runs: s.runs.map((r) => runRow(t, r, now)),
    spent: s.spec.kind === 'once' && s.spec.at <= now,
  }));
  const settings = store.settings;
  return {
    rows,
    projects: Object.values(store.projects).filter((p) => p.status !== 'archived').map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)),
    sessions: Object.values(store.sessions).filter((s) => s.projectId !== null).sort((a, b) => (b.lastTurnAt ?? 0) - (a.lastTurnAt ?? 0)).slice(0, 50).map((s) => ({ id: s.id, name: s.name || s.summary?.title || s.id })),
    agents: [
      { id: 'claude-code', label: agentLabel('claude-code') },
      ...(settings && codexEnabledOf(settings) ? [{ id: 'codex', label: agentLabel('codex') }] : []),
      ...(settings && opencodeEnabledOf(settings) ? [{ id: 'opencode', label: agentLabel('opencode') }] : []),
    ],
  };
}

const LABELS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'opencode' };
const agentLabel = (a: string): string => LABELS[a] ?? a;
