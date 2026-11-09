import { SCHEDULE_MAX_EVERY_MINUTES, SCHEDULE_MIN_EVERY_MINUTES, SCHEDULE_PROMPT_MAX, type ScheduleInput, type ScheduleSpec, type ScheduleTarget } from '@agent-hangar/shared';
import { useEffect, useRef, useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { ScheduleRow, SchedulesProps } from '../presenters/schedules.ts';
import { EventBindingForm } from './EventBindingForm.tsx';
import { EventList } from './EventRows.tsx';
import { PageHeading } from './PageHeading.tsx';
import { useFlip } from './primitives/flip.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { collapseOut } from './primitives/motionKit.ts';
import { Segmented } from './primitives/Segmented.tsx';
import { Grow, RunDots, RunList } from './schedulesParts.tsx';
import { scheduleTargetOf, useLaunchChoice, type LaunchBuilt } from './useLaunchChoice.tsx';

/** 月曜を頭にした曜日の並び。値は Date.getDay()。 */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const localTime = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** 送り先が新しい会話のときの起動の項目（プロジェクト、エージェント、モデルなど）は、useLaunchChoice が持つ。 */
type Draft = {
  prompt: string; kind: ScheduleSpec['kind']; days: number[]; time: string; minutes: string; date: string;
  dest: ScheduleTarget['kind']; sessionId: string;
};

function draftOf(props: SchedulesProps, row: ScheduleRow | null): Draft {
  const tomorrow = Date.now() + 86_400_000;
  const base: Draft = {
    prompt: '', kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00', minutes: '30', date: localDate(tomorrow),
    dest: 'new', sessionId: props.sessions[0]?.id ?? '',
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
    ...(t.kind === 'session' ? { sessionId: t.sessionId } : {}),
  };
}

/** 入力から送る形を組む。足りなければ null で、作成のボタンが押せない。new は新しい会話の札から組んだ起動の項目で、送り先が既存の会話のときは null。 */
function inputOf(d: Draft, built: LaunchBuilt | null, blocked: boolean): ScheduleInput | null {
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
  if (d.dest === 'new') {
    // フォルダを選んだときは、保存の後にプロジェクトを登録する（mediator）。そのとき target の projectId は空で、登録した id に差し替わる。
    if (!built || blocked || !(built.params.scratch || built.params.projectId || built.place)) return null;
    return { prompt: d.prompt, spec, target: scheduleTargetOf(built.params) };
  }
  return d.sessionId ? { prompt: d.prompt, spec, target: { kind: 'session', sessionId: d.sessionId } } : null;
}

function ScheduleForm(props: SchedulesProps & { row: ScheduleRow | null; onClose: () => void }) {
  const emit = useEmit();
  const t = useT();
  const [d, setD] = useState<Draft>(() => draftOf(props, props.row));
  const set = (p: Partial<Draft>) => setD((cur) => ({ ...cur, ...p }));
  // 新しい会話の札は新しいセッションのダイアログと同じ部品で、前回値と下書きは持ち込まない。作るときは、最初のプロジェクト（無ければクイックセッション）を選んでおく。
  const saved = props.row?.target.kind === 'new' ? props.row.target : null;
  const first = props.launch.projects.find((p) => p.status !== 'archived')?.id ?? null;
  const lc = useLaunchChoice({ data: props.launch, projectId: first, scratch: first === null, schedule: { target: saved } });
  const built = d.dest === 'new' ? lc.build() : null;
  const input = inputOf(d, built, lc.blocked);
  const bypass = d.dest === 'new' && lc.bypass;
  const save = () => {
    if (!input) return;
    const place = built?.place ? { place: built.place } : {};
    emit(props.row ? { type: 'schedule.update', id: props.row.id, patch: input, ...place } : { type: 'schedule.create', input, ...place });
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
      {/* 送り先の切り替えで、札の列と会話の選択を高さで開け閉めする。札の値は開け閉めで失わない（useLaunchChoice が親で持つ）。 */}
      <Grow open={d.dest === 'new'}>{() => <div className="sch-launch">{lc.chips}{lc.notes}</div>}</Grow>
      <Grow open={d.dest === 'session'}>
        {() => <div className="sch-line"><select className="input sch-session" aria-label={t('schedules.form.session')} value={d.sessionId} onChange={(e) => set({ sessionId: e.target.value })}>{props.sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>}
      </Grow>
      <div className="sch-foot">
        <button type="button" className="btn btn-ghost" onClick={props.onClose}>{t('common.button.cancel')}</button>
        <button type="button" className={`btn ${bypass ? 'btn-danger-fill' : 'btn-primary'}`} disabled={!input} onClick={save}>{t(bypass ? (props.row ? 'schedules.form.saveBypass' : 'schedules.form.createBypass') : props.row ? 'schedules.form.save' : 'schedules.form.create')}</button>
      </div>
    </div>
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
              {r.chips.length > 0 && (
                <div className="sch-chips">
                  {r.chips.map((c) => <span key={c.name} className="set-chip sch-chip" data-tone={c.danger ? 'danger' : 'default'}><span className="set-chip-name">{c.name}</span><span className="set-chip-value">{c.value}</span>{c.suffix && <span className="wt-suffix" aria-hidden="true">{c.suffix}</span>}</span>)}
                </div>
              )}
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

/**
 * イベントを読み直す間隔。
 * サーバに押し出す道が無いので、画面を開いている間だけ、この間隔で読む。
 */
const EVENTS_POLL_MS = 15_000;
const KINDS = ['time', 'github', 'hook'] as const;
type Kind = (typeof KINDS)[number];

/**
 * 作成の入口。
 * イベントが使えるときは、先に種類のカード（時刻、GitHub、webhook）を選ぶ。
 * 時刻は今までの予定のフォームのまま。
 */
function CreateFlow(props: SchedulesProps & { onClose: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<Kind>('time');
  if (!props.events) return <ScheduleForm {...props} row={null} onClose={props.onClose} />;
  return (
    <div className="sch-create">
      <div className="sch-kinds" role="radiogroup" aria-label={t('schedules.action.new')}>
        {KINDS.map((k) => (
          <button key={k} type="button" role="radio" className="sch-kind" aria-checked={kind === k} onClick={() => setKind(k)}>
            {k !== 'time' && <Icon name="bolt" />}<span>{t(`schedules.event.kind.${k}` as 'schedules.event.kind.time')}</span>
          </button>
        ))}
      </div>
      {kind === 'time' ? <ScheduleForm {...props} row={null} onClose={props.onClose} /> : <EventBindingForm key={kind} {...props} kind={kind} onClose={props.onClose} />}
    </div>
  );
}

/** 予定の画面（#549）。1 列で、行を押すとその場で開く。作成は一覧の頭に垂れて開く。入力は送るまで外へ出ないので、ここに持つ。 */
export function SchedulesScreen(props: SchedulesProps) {
  const t = useT();
  const emit = useEmit();
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const flip = useFlip(props.rows.map((r) => r.id));
  const ev = props.events;
  // イベントは開いたときに読み、開いている間は一定の間隔で読み直す。
  // 使えない PC では読みに行かない。
  const available = ev !== null;
  useEffect(() => {
    if (!available) return;
    emit({ type: 'events.load' });
    const id = setInterval(() => emit({ type: 'events.load' }), EVENTS_POLL_MS);
    return () => clearInterval(id);
  }, [available, emit]);
  const eventCount = ev ? ev.drafts.length + ev.claims.length + ev.rows.length : 0;
  // 節は、行か失敗の一文があるときだけ出す。
  // 時刻の見出しは、イベントの節と並ぶときだけ出す。
  const showEvents = ev !== null && (eventCount > 0 || ev.error !== null);
  // イベントの節が出るとき（行か失敗の一文があるとき）は、空の案内で隠さない。
  // 予定も行も無いまま読み込みが失敗した一文を出すため。
  const empty = props.rows.length === 0 && eventCount === 0 && !showEvents;
  return (
    <div className="screen schedules-screen">
      <PageHeading title={t('schedules.heading.title')}>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={() => { setCreating(true); setOpen(null); }}><Icon name="add" /><span className="btn-label">{t('schedules.action.new')}</span></button>
      </PageHeading>
      {empty && !creating && <div className="empty">{t('schedules.list.empty')}</div>}
      {(!empty || creating) && (
        <div className="sch-list">
          <Grow open={creating}>{() => <CreateFlow {...props} onClose={() => setCreating(false)} />}</Grow>
          {showEvents && props.rows.length > 0 && <h2 className="sch-sec">{t('schedules.section.time')}</h2>}
          {props.rows.map((row) => <ScheduleRowView key={row.id} {...props} row={row} open={open === row.id} onOpen={setOpen} rowRef={flip(row.id)} />)}
          {ev && showEvents && (
            <section className="sch-events" aria-label={t('schedules.section.event')}>
              <h2 className="sch-sec"><Icon name="bolt" />{t('schedules.section.event')}</h2>
              {ev.error && <div className="sch-ev-error" role="alert">{ev.error}</div>}
              <EventList drafts={ev.drafts} claims={ev.claims} rows={ev.rows} rev={ev.rev} open={open} onOpen={setOpen} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
