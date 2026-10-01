import { useState, type KeyboardEvent } from 'react';
import { isReturnOn, STATE_NOTE_MAX } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { PauseChoice, PauseProps } from '../presenters/pause.ts';
import { isComposing } from './ime.ts';
import { Dialog } from './primitives/Dialog.tsx';

const DIGITS = ['1', '2', '3', '4', '5'];
/** 改行は 1 つの空白にたたみ、前後の空白を落とす。サーバ（sessions/states.ts）の整え方と同じにする。 */
const tidy = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/**
 * Paused の入力（B1）。戻る日の札を 5 つ並べ、下に理由の 1 行を置く。
 * 札は打鍵 1〜5 でも選べる。理由の欄と日付の欄で打った数字はその欄の文字なので、横取りしない。
 * 入力は送るまで外へ出ないので、Mediator ではなくここに持つ（PromoteDialog と同じ）。
 * 提案から開いて理由を変えずに送れば、提案の確定に日を添える。変えたら手で選んだことにする（set_by は user）。
 */
export function PauseDialog(props: PauseProps) {
  const emit = useEmit();
  const initial: PauseChoice['key'] = props.choices.find((c) => c.returnOn === props.initialReturnOn)?.key ?? 'pick';
  const [choice, setChoice] = useState<PauseChoice['key']>(initial);
  const [picked, setPicked] = useState(initial === 'pick' ? props.initialReturnOn : '');
  const [note, setNote] = useState(props.draft);
  const returnOn = choice === 'pick' ? (isReturnOn(picked) ? picked : null) : props.choices.find((c) => c.key === choice)?.returnOn ?? null;
  // 字数は文字単位で数える。サーバと同じ数え方にしないと、通るはずの理由が 400 で返る。
  const text = tidy(note);
  const length = Array.from(text).length;
  const canSubmit = returnOn !== null && length <= STATE_NOTE_MAX;

  const close = () => emit({ type: 'session.pause.close' });
  const submit = () => {
    if (!canSubmit || returnOn === null) return;
    if (props.from === 'candidate' && text === tidy(props.candidateNote ?? '')) {
      emit({ type: 'session.state.confirm', id: props.sessionId, returnOn });
      return;
    }
    emit({ type: 'session.state.set', id: props.sessionId, status: 'paused', returnOn, ...(text ? { note: text } : {}) });
  };

  // 札の打鍵。欄の中の打鍵と、修飾の付いた打鍵は扱わない。
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
    const c = props.choices[DIGITS.indexOf(e.key)];
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
      title="Paused にする"
      titleAside={props.from === 'candidate' ? <span className="pause-draft">Claude の下書き</span> : undefined}
      className="dialog-pause"
      onClose={close}
      closeOnBackdrop={false}
      onKeyDown={onKeyDown}
      footer={<><button type="button" className="btn" onClick={close}>やめる</button><span className="spacer" /><button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={submit}>Paused にする</button></>}
    >
      <div className="faint">{props.sessionName}</div>
      <div className="pause-chips" role="radiogroup" aria-label="戻る日の候補">
        {props.choices.map((c, i) => (
          <button key={c.key} type="button" role="radio" aria-checked={choice === c.key} className="pause-chip" data-autofocus={c.key === initial ? 'true' : undefined} onClick={() => setChoice(c.key)}>
            {c.label}<kbd>{i + 1}</kbd>
          </button>
        ))}
      </div>
      {choice === 'pick' && (
        <label className="field">日付
          <input type="date" className="input" min={props.today} value={picked} onChange={(e) => setPicked(e.target.value)} onKeyDown={onFieldKey} />
        </label>
      )}
      <label className="field">何を確かめに戻るか
        <input className="input" aria-label="理由" value={note} placeholder="明日の朝、本番の CPU の数字を見る" onChange={(e) => setNote(e.target.value)} onKeyDown={onFieldKey} />
      </label>
      <div className={length > STATE_NOTE_MAX ? 'error' : 'faint'} aria-live="polite">{length} / {STATE_NOTE_MAX} 字</div>
    </Dialog>
  );
}
