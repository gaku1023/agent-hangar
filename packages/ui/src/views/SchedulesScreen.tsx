import { formatRoute, SCHEDULE_MAX_EVERY_MINUTES, SCHEDULE_MIN_EVERY_MINUTES, SCHEDULE_PROMPT_MAX, SCHEDULE_RUNS_KEPT, type ScheduleInput, type ScheduleSpec, type ScheduleTarget } from '@agent-hangar/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { ScheduleRow, ScheduleRunRow, SchedulesProps } from '../presenters/schedules.ts';
import { PageHeading } from './PageHeading.tsx';
import { useFlip } from './primitives/flip.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { collapseOut, growIn, popMark } from './primitives/motionKit.ts';
import { Segmented } from './primitives/Segmented.tsx';
import { usePresence } from './primitives/usePresence.ts';

/** 月曜を頭にした曜日の並び。値は Date.getDay()。 */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const localTime = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

type Draft = {
  prompt: string; kind: ScheduleSpec['kind']; days: number[]; time: string; minutes: string; date: string;
  dest: ScheduleTarget['kind']; projectId: string; agent: string; sessionId: string;
};

function draftOf(props: SchedulesProps, row: ScheduleRow | null): Draft {
  const tomorrow = Date.now() + 86_400_000;
  const base: Draft = {
    prompt: '', kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00', minutes: '30', date: localDate(tomorrow),
    dest: 'new', projectId: props.projects[0]?.id ?? '', agent: 'claude-code', sessionId: props.sessions[0]?.id ?? '',
  };
  if (!row) return base;
  const s = row.spec;
  const t = row.target;
  return {
    ...base, prompt: row.prompt, kind: s.kind,
    ...(s.kind === 'weekly' ? { days: s.days, time: s.time } : {}),
    ...(s.kind === 'every' ? { minutes: String(s.minutes) } : {}),
    ...(s.kind === 'once' ? { date: localDate(s.at), time: localTime(s.at) } : {}),
    dest: t.kind,
    ...(t.kind === 'new' ? { projectId: t.projectId, agent: t.agent ?? 'claude-code' } : { sessionId: t.sessionId }),
  };
}

/** 入力から送る形を組む。足りなければ null で、作成のボタンが押せない。 */
function inputOf(d: Draft): ScheduleInput | null {
  if (!d.prompt.trim() || d.prompt.length > SCHEDULE_PROMPT_MAX) return null;
  let spec: ScheduleSpec;
  if (d.kind === 'weekly') {
    if (d.days.length === 0 || !d.time) return null;
    spec = { kind: 'weekly', days: d.days, time: d.time };
  } else if (d.kind === 'every') {
    const minutes = Number(d.minutes);
    if (!Number.isInteger(minutes) || minutes < SCHEDULE_MIN_EVERY_MINUTES || minutes > SCHEDULE_MAX_EVERY_MINUTES) return null;
    spec = { kind: 'every', minutes };
  } else {
    const at = new Date(`${d.date}T${d.time}`).getTime();
    if (!Number.isFinite(at) || at <= Date.now()) return null;
    spec = { kind: 'once', at };
  }
  if (d.dest === 'new') return d.projectId ? { prompt: d.prompt, spec, target: { kind: 'new', projectId: d.projectId, ...(d.agent !== 'claude-code' ? { agent: d.agent } : {}) } } : null;
  return d.sessionId ? { prompt: d.prompt, spec, target: { kind: 'session', sessionId: d.sessionId } } : null;
}

function ScheduleForm(props: SchedulesProps & { row: ScheduleRow | null; onClose: () => void }) {
  const emit = useEmit();
  const t = useT();
  const [d, setD] = useState<Draft>(() => draftOf(props, props.row));
  const set = (p: Partial<Draft>) => setD((cur) => ({ ...cur, ...p }));
  const input = inputOf(d);
  const save = () => {
    if (!input) return;
    emit(props.row ? { type: 'schedule.update', id: props.row.id, patch: input } : { type: 'schedule.create', input });
    props.onClose();
  };
  return (
    <div className="sch-form">
      <textarea className="input sch-prompt" autoFocus aria-label={t('schedules.form.prompt')} placeholder={t('schedules.form.prompt')} value={d.prompt} onChange={(e) => set({ prompt: e.target.value })} />
      <Segmented label={t('schedules.form.kind')} value={d.kind} onChange={(v) => set({ kind: v as Draft['kind'] })}
        options={[{ value: 'weekly', label: t('schedules.form.kind.weekly') }, { value: 'every', label: t('schedules.form.kind.every') }, { value: 'once', label: t('schedules.form.kind.once') }]} />
      <div className="sch-line" key={d.kind}>
        {d.kind === 'weekly' && (
          <>
            <div className="sch-days">
              {WEEK.map((day) => {
                const on = d.days.includes(day);
                return <button key={day} type="button" className="sch-day" aria-pressed={on} onClick={() => set({ days: on ? d.days.filter((x) => x !== day) : [...d.days, day] })}>{t(`schedules.day.d${day}` as 'schedules.day.d0')}</button>;
              })}
            </div>
            <input className="input" type="time" aria-label={t('schedules.form.time')} value={d.time} onChange={(e) => set({ time: e.target.value })} />
          </>
        )}
        {d.kind === 'every' && <><input className="input sch-minutes" type="number" min={SCHEDULE_MIN_EVERY_MINUTES} max={SCHEDULE_MAX_EVERY_MINUTES} aria-label={t('schedules.form.minutes')} value={d.minutes} onChange={(e) => set({ minutes: e.target.value })} /><span>{t('schedules.form.minutes')}</span></>}
        {d.kind === 'once' && (
          <>
            <input className="input" type="date" aria-label={t('schedules.form.date')} value={d.date} onChange={(e) => set({ date: e.target.value })} />
            <input className="input" type="time" aria-label={t('schedules.form.time')} value={d.time} onChange={(e) => set({ time: e.target.value })} />
          </>
        )}
      </div>
      <Segmented label={t('schedules.form.dest')} value={d.dest} onChange={(v) => set({ dest: v as Draft['dest'] })}
        options={[{ value: 'new', label: t('schedules.form.dest.new') }, { value: 'session', label: t('schedules.form.dest.session') }]} />
      <div className="sch-line" key={d.dest}>
        {d.dest === 'new'
          ? (
            <>
              <select className="input" aria-label={t('schedules.form.project')} value={d.projectId} onChange={(e) => set({ projectId: e.target.value })}>{props.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              <select className="input" aria-label={t('schedules.form.agent')} value={d.agent} onChange={(e) => set({ agent: e.target.value })}>{props.agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select>
            </>
          )
          : <select className="input sch-session" aria-label={t('schedules.form.session')} value={d.sessionId} onChange={(e) => set({ sessionId: e.target.value })}>{props.sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
      </div>
      <div className="sch-foot">
        <button type="button" className="btn btn-ghost" onClick={props.onClose}>{t('common.button.cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={!input} onClick={save}>{t(props.row ? 'schedules.form.save' : 'schedules.form.create')}</button>
      </div>
    </div>
  );
}

/** 開け閉めの枠。中身が出入りするときに高さを動かす。 */
function Grow(props: { open: boolean; children: () => React.ReactNode }) {
  const { mounted, ref } = usePresence<HTMLDivElement>(props.open, (el) => collapseOut(el));
  useLayoutEffect(() => { if (props.open && ref.current) growIn(ref.current); }, [props.open, ref, mounted]);
  if (!mounted) return null;
  return <div ref={ref} className="sch-grow">{props.children()}</div>;
}

/** 直近の回の丸。新しい回が来たら、その丸だけ跳ねる。 */
function RunDots(props: { runs: ScheduleRunRow[] }) {
  const box = useRef<HTMLSpanElement>(null);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (seen.current) {
      for (const r of props.runs) {
        if (seen.current.has(r.id)) continue;
        const el = box.current?.querySelector<HTMLElement>(`[data-run="${r.id}"]`);
        if (el) popMark(el);
      }
    }
    seen.current = new Set(props.runs.map((r) => r.id));
  }, [props.runs]);
  // 古い回を左に、新しい回を右に置く。
  return <span className="sch-dots" ref={box}>{[...props.runs].slice(0, SCHEDULE_RUNS_KEPT).reverse().map((r) => <i key={r.id} data-run={r.id} className="sch-dot" data-result={r.result} role="img" aria-label={`${r.at} ${r.label}`} title={`${r.at} ${r.label}`} />)}</span>;
}

function RunList(props: { runs: ScheduleRunRow[] }) {
  const emit = useEmit();
  if (props.runs.length === 0) return null;
  return (
    <ul className="sch-runs">
      {props.runs.map((r) => (
        <li key={r.id} className="sch-run">
          <i className="sch-dot" data-result={r.result} aria-hidden="true" />
          {r.sessionId
            ? <a className="sch-run-name" href={formatRoute({ name: 'session', id: r.sessionId })} onClick={(e) => { e.preventDefault(); emit({ type: 'nav.go', to: { name: 'session', id: r.sessionId! } }); }}>{r.title || r.label}</a>
            : <span className="sch-run-name faint">{r.label}</span>}
          <span className="faint num">{r.took ?? ''}</span>
          <span className="num">{r.at}</span>
        </li>
      ))}
    </ul>
  );
}

function ScheduleRowView(props: SchedulesProps & { row: ScheduleRow; open: boolean; onOpen: (id: string | null) => void; rowRef: (el: HTMLElement | null) => void }) {
  const emit = useEmit();
  const t = useT();
  const r = props.row;
  const [editing, setEditing] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const [gone, setGone] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (!props.open) { setEditing(false); setAskDelete(false); } }, [props.open]);
  const remove = () => {
    setGone(true);
    const el = box.current;
    void (el ? collapseOut(el) : Promise.resolve()).then(() => emit({ type: 'schedule.delete', id: r.id }));
  };
  return (
    <div className="sch-row" data-off={r.enabled ? undefined : 'true'} data-open={props.open ? 'true' : undefined} data-gone={gone ? 'true' : undefined} ref={(el) => { box.current = el; props.rowRef(el); }}>
      <div className="sch-head" onClick={() => props.onOpen(props.open ? null : r.id)}>
        <button type="button" className="switch" role="switch" aria-checked={r.enabled} disabled={r.spent && !r.enabled} aria-label={t(r.enabled ? 'schedules.action.pause' : 'schedules.action.resume')}
          onClick={(e) => { e.stopPropagation(); emit({ type: 'schedule.update', id: r.id, patch: { enabled: !r.enabled } }); }} />
        <button type="button" className="sch-title" aria-expanded={props.open}>{r.prompt}</button>
        <span className="sch-when">{r.when}</span>
        <span className="sch-next num">{r.next}</span>
        <RunDots runs={r.runs} />
      </div>
      <Grow open={props.open}>
        {() => editing
          ? <ScheduleForm {...props} row={r} onClose={() => setEditing(false)} />
          : (
            <div className="sch-detail">
              <div className="faint">{r.dest}</div>
              <div className="sch-full">{r.prompt}</div>
              <RunList runs={r.runs} />
              <div className="sch-acts">
                <button type="button" className="btn" onClick={() => emit({ type: 'schedule.run', id: r.id })}>{t('schedules.action.run')}</button>
                <button type="button" className="btn btn-ghost" onClick={() => setEditing(true)}>{t('schedules.action.edit')}</button>
                <span className="spacer" />
                {askDelete
                  ? <><button type="button" className="btn btn-ghost" onClick={() => setAskDelete(false)}>{t('common.button.cancel')}</button><button type="button" className="btn btn-danger-fill" onClick={remove}>{t('schedules.action.deleteConfirm')}</button></>
                  : <button type="button" className="btn btn-ghost btn-danger" onClick={() => setAskDelete(true)}>{t('schedules.action.delete')}</button>}
              </div>
            </div>
          )}
      </Grow>
    </div>
  );
}

/** 予定の画面（#549）。1 列で、行を押すとその場で開く。作成は一覧の頭に垂れて開く。入力は送るまで外へ出ないので、ここに持つ。 */
export function SchedulesScreen(props: SchedulesProps) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const flip = useFlip(props.rows.map((r) => r.id));
  return (
    <div className="screen schedules-screen">
      <PageHeading title={t('schedules.heading.title')}>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={() => { setCreating(true); setOpen(null); }}><Icon name="add" /><span className="btn-label">{t('schedules.action.new')}</span></button>
      </PageHeading>
      {props.rows.length === 0 && !creating && <div className="empty">{t('schedules.list.empty')}</div>}
      {(props.rows.length > 0 || creating) && (
        <div className="sch-list">
          <Grow open={creating}>{() => <ScheduleForm {...props} row={null} onClose={() => setCreating(false)} />}</Grow>
          {props.rows.map((row) => <ScheduleRowView key={row.id} {...props} row={row} open={open === row.id} onOpen={setOpen} rowRef={flip(row.id)} />)}
        </div>
      )}
    </div>
  );
}
