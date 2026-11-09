import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { GITHUB_REPO_RE, isReturnOn, isReturnTime, STATE_NOTE_MAX, type Translate, type WakeOn } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { PauseChoice, PauseProps } from '../presenters/pause.ts';
import { isComposing } from './ime.ts';
import { Dialog } from './primitives/Dialog.tsx';
import { useT } from './primitives/language.tsx';
import { collapseOut, fadeIn, growIn, motionOn } from './primitives/motionKit.ts';
import { usePresence } from './primitives/usePresence.ts';

/** 起こす条件の 4 つ。札の順は w12 のとおり。 */
const WAKE_WHENS: { when: WakeOn['when']; sentence: 'pause.wake.ciDone' | 'pause.wake.ciFailed' | 'pause.wake.review' | 'pause.wake.merged'; chip: 'pause.wake.when.ciDone' | 'pause.wake.when.ciFailed' | 'pause.wake.when.review' | 'pause.wake.when.merged' }[] = [
  { when: 'ci_done', sentence: 'pause.wake.ciDone', chip: 'pause.wake.when.ciDone' },
  { when: 'ci_failed', sentence: 'pause.wake.ciFailed', chip: 'pause.wake.when.ciFailed' },
  { when: 'review', sentence: 'pause.wake.review', chip: 'pause.wake.when.review' },
  { when: 'merged', sentence: 'pause.wake.merged', chip: 'pause.wake.when.merged' },
];
/** PR の番号（先頭が 0 でない整数）。repo の形は shared の GITHUB_REPO_RE で、サーバと同じ。 */
const PR_RE = /^[1-9]\d{0,9}$/;
/** 画面で編集中の条件。pr は打ちかけの文字で持つ。picked は自分で選んだ（欄を出す）か、提案のままか。 */
type WakeDraft = { repo: string; pr: string; when: WakeOn['when']; picked: boolean };
const wakeOf = (d: WakeDraft | null): WakeOn | null => (d && GITHUB_REPO_RE.test(d.repo.trim()) && PR_RE.test(d.pr.trim()) ? { repo: d.repo.trim(), pr: Number(d.pr.trim()), when: d.when } : null);

const BOLT = (
  <svg className="pause-wake-bolt" viewBox="0 0 12 12" aria-hidden="true"><path d="M7 0 1.5 7H5.5L4.5 12 10.5 4.5H6.5z" /></svg>
);

/**
 * 起こす条件の札（A4）。文の 1 枚に「外す」を添える。自分で選ぶときの repo と PR の欄は、点線の「＋」から出した札にだけ付く。
 * 入るときは高さを伸ばし（growIn）、外すときは畳む（collapseOut）。畳む間は外す前の文を出し続ける。
 */
function WakeCard(props: { draft: WakeDraft | null; t: Translate; onChange: (d: WakeDraft) => void; onRemove: () => void; onFieldKey: (e: KeyboardEvent<HTMLInputElement>) => void }) {
  const { t } = props;
  const last = useRef(props.draft);
  if (props.draft) last.current = props.draft;
  const card = usePresence<HTMLDivElement>(props.draft !== null, (el) => (motionOn(el) ? collapseOut(el) : null));
  // 開いたときから居る札は動かさない。あとから出たときだけ伸ばす。
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    if (props.draft !== null && card.ref.current) growIn(card.ref.current);
    // 出入りの変わり目だけで動かす。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.draft !== null]);
  const d = last.current;
  if (!card.mounted || !d) return null;
  const row = WAKE_WHENS.find((w) => w.when === d.when)!;
  const set = (patch: Partial<WakeDraft>) => props.onChange({ ...d, ...patch });
  return (
    <div ref={card.ref} className="pause-wake" aria-hidden={card.leaving ? true : undefined}>
      <div className="pause-wake-line">
        {BOLT}
        <span className="pause-wake-sentence">{t(row.sentence, { pr: d.pr.trim() })}</span>
        {!d.picked && <span className="pause-wake-repo">{d.repo}</span>}
        <button type="button" className="btn" disabled={card.leaving} onClick={props.onRemove}>{t('pause.wake.remove')}</button>
      </div>
      {d.picked && (
        <div className="pause-wake-fields">
          <input className="input" aria-label={t('pause.wake.repo')} placeholder="owner/repo" value={d.repo} spellCheck={false} autoComplete="off" onChange={(e) => set({ repo: e.target.value })} onKeyDown={props.onFieldKey} />
          <input className="input pause-wake-pr" inputMode="numeric" aria-label={t('pause.wake.pr')} placeholder="#" value={d.pr} spellCheck={false} autoComplete="off" onChange={(e) => set({ pr: e.target.value })} onKeyDown={props.onFieldKey} />
        </div>
      )}
      <div className="pause-chips" role="radiogroup" aria-label={t('pause.wake.when.aria')}>
        {WAKE_WHENS.map((w) => (
          <button key={w.when} type="button" role="radio" aria-checked={d.when === w.when} className="pause-chip pause-wake-chip" onClick={() => set({ when: w.when })}>{t(w.chip)}</button>
        ))}
      </div>
    </div>
  );
}

/** 点線の「＋ イベントで起こす」。札を外したあとに、薄れて戻ってくる（開いたときから居るものは動かさない）。 */
function WakeAdd(props: { label: string; animate: boolean; onAdd: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (props.animate && ref.current) fadeIn(ref.current, '--dur-fast'); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <button ref={ref} type="button" className="pause-wake-add" onClick={props.onAdd}>{props.label}</button>;
}

/** 日のある札の打鍵。日付なしの札は 0 で、日のある札は今までどおり 1 から数える。 */
const DIGITS = ['1', '2', '3', '4', '5'];
const NONE_DIGIT = '0';
/** 改行は 1 つの空白にたたみ、前後の空白を落とす。サーバ（sessions/states.ts）の整え方と同じにする。 */
const tidy = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/**
 * Paused の入力（B1）。戻る日の札を 5 つ並べ、下に理由の 1 行を置く。
 * 札は打鍵 1〜5 でも選べる。理由の欄と日付の欄で打った数字はその欄の文字なので、横取りしない。
 * 入力は送るまで外へ出ないので、Mediator ではなくここに持つ（PromoteDialog と同じ）。
 * 提案から開いて理由を変えずに送れば、提案の確定に日を添える。変えたら手で選んだことにする（set_by は user）。
 * 時刻の欄は任意で、空なら「その日のうち」になる。入れたときだけ戻る時刻として送る。
 * 「日付なし」（2026-10-13）は札の並びの頭の枠だけの札で、打鍵は 0。選ぶと時刻の欄は押せなくなり、日も時刻も送らない。
 */
export function PauseDialog(props: PauseProps) {
  const emit = useEmit();
  const t = useT();
  const initial: PauseChoice['key'] = props.initialReturnOn === null ? 'none' : props.choices.find((c) => c.key !== 'none' && c.returnOn === props.initialReturnOn)?.key ?? 'pick';
  const [choice, setChoice] = useState<PauseChoice['key']>(initial);
  const [picked, setPicked] = useState(initial === 'pick' ? props.initialReturnOn ?? '' : '');
  const none = choice === 'none';
  // 日のある札だけに 1 から打鍵を割り当てる（日付なしは 0）。
  const dated = props.choices.filter((c) => c.key !== 'none');
  const [note, setNote] = useState(props.draft);
  const [time, setTime] = useState(props.initialReturnTime);
  // 起こす条件（#563）。提案があれば文のカードで見せ、無ければ点線の「＋」から選ぶ。props.wake が null（クラウド無し）なら出さない。
  const suggested = props.wake?.suggested ?? null;
  const [wake, setWake] = useState<WakeDraft | null>(suggested ? { repo: suggested.repo, pr: String(suggested.pr), when: suggested.when, picked: false } : null);
  const [removed, setRemoved] = useState(false);
  const wakeOn = wakeOf(wake);
  // 送るのは、画面が見せた結果である。外したなら null、無ければ null（サーバは object のときだけ結び付けを作る）。
  const wakeExtra = props.wake ? { wakeOn } : {};
  // 空と、打ちかけで形になっていない時刻は、時刻なしとして送る。
  const returnTime = !none && isReturnTime(time) ? { returnTime: time } : {};
  const returnOn = choice === 'pick' ? (isReturnOn(picked) ? picked : null) : props.choices.find((c) => c.key === choice)?.returnOn ?? null;
  // 字数は文字単位で数える。サーバと同じ数え方にしないと、通るはずの理由が 400 で返る。
  const text = tidy(note);
  const length = Array.from(text).length;
  // 札があるのに repo と PR の形が違うときは送れない。外せば送れる。
  const canSubmit = (none || returnOn !== null) && length <= STATE_NOTE_MAX && (wake === null || wakeOn !== null);

  const close = () => emit({ type: 'session.pause.close' });
  const submit = () => {
    if (!canSubmit) return;
    const unchanged = props.from === 'candidate' && text === tidy(props.candidateNote ?? '');
    if (none) {
      // 日付なしの提案を変えずに送れば確定にする。日のある提案を日付なしにしたときは、確定では日を外せないので、手で選んだことにする。
      if (unchanged && props.initialReturnOn === null) { emit({ type: 'session.state.confirm', id: props.sessionId, ...wakeExtra }); return; }
      emit({ type: 'session.state.set', id: props.sessionId, status: 'paused', ...(text ? { note: text } : {}), ...wakeExtra });
      return;
    }
    if (returnOn === null) return;
    if (unchanged) {
      emit({ type: 'session.state.confirm', id: props.sessionId, returnOn, ...returnTime, ...wakeExtra });
      return;
    }
    emit({ type: 'session.state.set', id: props.sessionId, status: 'paused', returnOn, ...returnTime, ...(text ? { note: text } : {}), ...wakeExtra });
  };

  // 札の打鍵。欄の中の打鍵と、修飾の付いた打鍵は扱わない。
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
    const c = e.key === NONE_DIGIT ? props.choices.find((x) => x.key === 'none') : dated[DIGITS.indexOf(e.key)];
    if (!c) return;
    e.preventDefault();
    setChoice(c.key);
  };
  // Enter で送る。変換中の Enter は確定のための打鍵なので、送信に使わない。
  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    submit();
  };

  // 理由を打ちかけたまま背景を押し違えても失わないよう、背景では閉じない。
  return (
    <Dialog
      title={t('pause.dialog.title')}
      titleAside={props.from === 'candidate' ? <span className="pause-draft">{t('pause.dialog.draftTag')}</span> : undefined}
      className="dialog-pause"
      onClose={close}
      closeOnBackdrop={false}
      onKeyDown={onKeyDown}
      footer={<><button type="button" className="btn" onClick={close}>{t('common.button.cancel')}</button><span className="spacer" /><button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={submit}>{t('pause.dialog.action')}</button></>}
    >
      <div className="faint">{props.sessionName}</div>
      <div className="pause-chips" role="radiogroup" aria-label={t('pause.choices.aria')}>
        {props.choices.map((c) => (
          <button key={c.key} type="button" role="radio" aria-checked={choice === c.key} className="pause-chip" data-none={c.key === 'none' ? 'true' : undefined} data-autofocus={c.key === initial ? 'true' : undefined} onClick={() => setChoice(c.key)}>
            {c.label}<kbd>{c.key === 'none' ? NONE_DIGIT : dated.indexOf(c) + 1}</kbd>
          </button>
        ))}
      </div>
      {choice === 'pick' && (
        <label className="field">{t('pause.field.date')}
          <input type="date" className="input" min={props.today} value={picked} onChange={(e) => setPicked(e.target.value)} onKeyDown={onFieldKey} />
        </label>
      )}
      {props.wake && (
        <>
          <WakeCard draft={wake} t={t} onChange={setWake} onRemove={() => { setWake(null); setRemoved(true); }} onFieldKey={onFieldKey} />
          {wake === null && <WakeAdd label={t('pause.wake.add')} animate={removed} onAdd={() => setWake({ repo: props.wake!.repo, pr: props.wake!.pr === null ? '' : String(props.wake!.pr), when: 'ci_done', picked: true })} />}
        </>
      )}
      <label className="field pause-time">{t('pause.field.time')}
        <input type="time" className="input" aria-label={t('pause.field.time')} value={time} disabled={none} onChange={(e) => setTime(e.target.value)} onKeyDown={onFieldKey} />
        <span className="faint">{t(none ? 'pause.field.timeHintNone' : 'pause.field.timeHint')}</span>
      </label>
      <label className="field">{t('pause.field.reason')}
        <input className="input" aria-label={t('pause.field.reason')} value={note} placeholder={t('pause.field.reasonPlaceholder')} onChange={(e) => setNote(e.target.value)} onKeyDown={onFieldKey} />
      </label>
      <div className={length > STATE_NOTE_MAX ? 'error' : 'faint'} aria-live="polite">{t('pause.field.count', { n: length, max: STATE_NOTE_MAX })}</div>
    </Dialog>
  );
}
