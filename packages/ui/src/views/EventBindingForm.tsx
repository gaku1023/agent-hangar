import { GITHUB_REPO_RE, SCHEDULE_PROMPT_MAX, type EventCreateAction, type EventCreateInput, type GithubWhen } from '@agent-hangar/shared';
import { useEffect, useRef, useState } from 'react';
import { useEmit } from '../action/chain.tsx';
import { githubWhenLabel, type SchedulesProps } from '../presenters/schedules.ts';
import { useT } from './primitives/language.tsx';
import { Segmented } from './primitives/Segmented.tsx';
import { Grow } from './schedulesParts.tsx';
import { scheduleTargetOf, useLaunchChoice, type LaunchBuilt } from './useLaunchChoice.tsx';

/** 見るできごとの並び。選んだ順ではなく、この順で送る。 */
const WHENS: GithubWhen[] = ['ci_done', 'ci_failed', 'review', 'comment', 'merged', 'issue_opened'];
type Dest = 'send' | 'send_pr_owner' | 'new';
type Draft = { repo: string; when: GithubWhen[]; pr: string; labels: string; dest: Dest; sessionId: string; prompt: string; passBody: boolean; allow: string };

/** PR の番号。1 から始まる 10 桁までの整数だけ。ほかの綴り（12a、0、空白入り）は「絞り込み無し」にせず、作れない入力にする。 */
const PR_RE = /^[1-9]\d{0,9}$/;
const LABEL_MAX = 50;
/** ラベルの欄が正しいか。空の項目（コンマの連続）と 50 字を超える項目があれば誤り。何も書かなければ正しい（絞り込み無し）。 */
const labelsOk = (s: string): boolean => s.trim() === '' || s.split(/[,、]/).every((x) => x.trim() !== '' && x.trim().length <= LABEL_MAX);

/** コンマ（全角の読点も）で分けて、前後の空白と空を捨てる。 */
const listOf = (s: string, sep: RegExp): string[] => s.split(sep).map((x) => x.trim()).filter(Boolean);

/** 入力から送る形を組む。足りなければ null で、作成のボタンが押せない。新しい会話は、プロジェクト（かクイックセッション）を選んだときだけ。 */
function inputOf(kind: 'github' | 'hook', d: Draft, built: LaunchBuilt | null, blocked: boolean): EventCreateInput | null {
  if (!d.prompt.trim() || d.prompt.length > SCHEDULE_PROMPT_MAX) return null;
  let action: EventCreateAction;
  if (d.dest === 'new') {
    if (!built || blocked || !(built.params.scratch || built.params.projectId)) return null;
    action = scheduleTargetOf(built.params);
  } else if (d.dest === 'send') {
    if (!d.sessionId) return null;
    action = { kind: 'send', sessionId: d.sessionId };
  } else {
    action = { kind: 'send_pr_owner' };
  }
  const base = { action, prompt: d.prompt, passBody: d.passBody };
  if (kind === 'hook') return { ...base, source: { kind: 'hook' }, allowAuthors: [] };
  const prText = d.pr.trim();
  if (!GITHUB_REPO_RE.test(d.repo) || d.when.length === 0 || (prText !== '' && !PR_RE.test(prText)) || !labelsOk(d.labels)) return null;
  const pr = prText === '' ? undefined : Number(prText);
  const labels = listOf(d.labels, /[,、]/);
  return { ...base, source: { kind: 'github', repo: d.repo, when: WHENS.filter((w) => d.when.includes(w)), ...(pr !== undefined ? { pr } : {}), ...(labels.length > 0 ? { labels } : {}) }, allowAuthors: d.passBody ? listOf(d.allow, /[,\s、]+/) : [] };
}

/**
 * GitHub と外の webhook の結び付けを作るフォーム（#563）。
 * 新しい会話の起動の札は、予定のフォームと同じ部品（useLaunchChoice）で、前回値と下書きは持ち込まない。
 * webhook を付けられなかった理由は、送ったあとにフォームの下の一文に出す。作れたら events.form.done が増えて閉じる。
 */
export function EventBindingForm(props: SchedulesProps & { kind: 'github' | 'hook'; onClose: () => void }) {
  const emit = useEmit();
  const t = useT();
  const form = props.events!.form;
  const [d, setD] = useState<Draft>(() => ({ repo: '', when: [], pr: '', labels: '', dest: 'new', sessionId: props.sessions[0]?.id ?? '', prompt: '', passBody: false, allow: '' }));
  const set = (p: Partial<Draft>) => setD((cur) => ({ ...cur, ...p }));
  const [sent, setSent] = useState(false);
  const first = props.launch.projects.find((p) => p.status !== 'archived')?.id ?? null;
  const lc = useLaunchChoice({ data: props.launch, projectId: first, scratch: first === null, schedule: { target: null } });
  const built = d.dest === 'new' ? lc.build() : null;
  const input = inputOf(props.kind, d, built, lc.blocked);
  const bypass = d.dest === 'new' && lc.bypass;
  // 作れた回数が増えたら閉じる。開いたときの値と比べるので、前に作った分では閉じない。
  const done0 = useRef(form.done);
  useEffect(() => { if (form.done > done0.current) props.onClose(); }, [form.done, props.onClose]);
  const save = () => {
    if (!input || form.busy) return;
    setSent(true);
    emit({ type: 'events.create', input });
  };
  const dests: { value: Dest; label: string }[] = [
    { value: 'send', label: t('schedules.event.action.send') },
    ...(props.kind === 'github' ? [{ value: 'send_pr_owner' as const, label: t('schedules.event.action.sendPrOwner') }] : []),
    { value: 'new', label: t('schedules.event.action.new') },
  ];
  const repoBad = d.repo !== '' && !GITHUB_REPO_RE.test(d.repo);
  const prBad = d.pr.trim() !== '' && !PR_RE.test(d.pr.trim());
  const labelsBad = !labelsOk(d.labels);
  return (
    <div className="sch-form sch-ev-form">
      {props.kind === 'github' && (
        <>
          <input className="input sch-repo" autoFocus aria-label={t('schedules.event.form.repo')} placeholder="owner/repo" aria-invalid={repoBad ? 'true' : undefined} value={d.repo} onChange={(e) => set({ repo: e.target.value.trim() })} />
          <div className="sch-days sch-whens" role="group" aria-label={t('schedules.event.form.when')}>
            {WHENS.map((w) => {
              const on = d.when.includes(w);
              return <button key={w} type="button" className="sch-opt" aria-pressed={on} onClick={() => set({ when: on ? d.when.filter((x) => x !== w) : [...d.when, w] })}>{githubWhenLabel(t, w)}</button>;
            })}
          </div>
          <div className="sch-line">
            <input className="input sch-pr" inputMode="numeric" aria-label={t('schedules.event.form.pr')} placeholder="#" aria-invalid={prBad ? 'true' : undefined} value={d.pr} onChange={(e) => set({ pr: e.target.value })} />
            <input className="input sch-labels" aria-label={t('schedules.event.form.labels')} placeholder={t('schedules.event.form.labels')} aria-invalid={labelsBad ? 'true' : undefined} value={d.labels} onChange={(e) => set({ labels: e.target.value })} />
          </div>
        </>
      )}
      <textarea className="input sch-prompt" autoFocus={props.kind === 'hook'} aria-label={t('schedules.form.prompt')} placeholder={t('schedules.form.prompt')} value={d.prompt} onChange={(e) => set({ prompt: e.target.value })} />
      <Segmented label={t('schedules.form.dest')} value={d.dest} onChange={(v) => set({ dest: v as Dest })} options={dests} />
      <Grow open={d.dest === 'new'}>{() => <div className="sch-launch">{lc.chips}{lc.notes}</div>}</Grow>
      <Grow open={d.dest === 'send'}>
        {() => <div className="sch-line"><select className="input sch-session" aria-label={t('schedules.form.session')} value={d.sessionId} onChange={(e) => set({ sessionId: e.target.value })}>{props.sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>}
      </Grow>
      <label className="sch-sw-row">
        <button type="button" className="switch" role="switch" aria-checked={d.passBody} aria-label={t('schedules.event.passBody')} onClick={() => set({ passBody: !d.passBody })} />
        <span>{t('schedules.event.passBody')}</span>
      </label>
      <Grow open={props.kind === 'github' && d.passBody}>
        {() => <input className="input sch-allow" aria-label={t('schedules.event.allowAuthors')} placeholder={t('schedules.event.allowAuthors')} value={d.allow} onChange={(e) => set({ allow: e.target.value })} />}
      </Grow>
      {sent && form.error && <div className="sch-ev-error" role="alert">{form.error}</div>}
      <div className="sch-foot">
        <button type="button" className="btn btn-ghost" onClick={props.onClose}>{t('common.button.cancel')}</button>
        <button type="button" className={`btn ${bypass ? 'btn-danger-fill' : 'btn-primary'}`} disabled={!input || form.busy} onClick={save}>{t(bypass ? 'schedules.form.createBypass' : 'schedules.form.create')}</button>
      </div>
    </div>
  );
}
