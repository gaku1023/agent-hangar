import { useLayoutEffect, useRef } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { CardLane, CardStep, NowCardProps } from '../presenters/live.ts';
import type { ArtifactCardProps } from '../presenters/project.ts';
import { NoteEditor } from './NoteEditor.tsx';
import { CountChip } from './primitives/Chip.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Popover } from './primitives/Popover.tsx';

/** ツール呼び出しの印。色だけに頼らないよう、形も変える（完了は ✓、いまと入力待ちは ●、失敗は ✕）。読み上げには語で言う。 */
const STEP_MARK = { done: '✓', now: '●', wait: '●', fail: '✕' } as const;

/**
 * 現在の札（2026-10-11 の試作の A2）。セッション画面の右の欄の上、目次の上に置く。
 * タブの列やターミナルにはくっつけない。中身はタブ（Claude かシェルか）ではなく、セッションのものだからである。
 * 上から、状態の行、入力待ちの問い（裏だけ動いているときはその 1 行）、意図の全文、直近 3 つのツール呼び出し、
 * 「ほか N」、サブエージェント、アーティファクトの数の札を積む。意図は切らずに折り返す。
 * 札の全体は読み上げの領域にせず（追記のたびに読み上げない）、状態の語だけを role="status" にする。
 * 動き（D3）：描いた後に増えた呼び出しはフェードで入り一度だけ光る。意図は替わったときにフェードで入れ替わる。灯は静止する。
 */
export function NowCard(props: NowCardProps & { sessionId: string }) {
  const t = useT();
  const dot = props.tone === 'wait' ? 'wait' : props.tone === 'busy' ? 'busy' : props.tone === 'aside' ? 'aside' : 'idle';
  const fresh = useFreshKeys(props.sessionId, props.steps.map((s) => s.key));
  const hidden = props.stepsTotal - props.steps.length;
  return (
    <section className="now-card" data-tone={props.tone} aria-label={t('session.strip.label')}>
      <div className="nc-head">
        <span className="nc-state" data-tone={props.tone}>
          <span className="live-dot" data-tone={dot} aria-hidden="true" />
          <span role="status">{props.state}</span>
        </span>
        {props.sub && <span className="nc-sub">{props.sub}</span>}
      </div>
      {props.detail !== null && (props.question
        ? <p className="nc-question" key={props.detail}><span className="nc-question-label">{t('session.strip.questionLabel')}</span><span className="nc-question-text">{props.detail}</span></p>
        : <p className="nc-detail">{props.detail}</p>)}
      {props.intent.kind === 'said'
        ? (
          <div className="nc-intent" key={props.intent.text} data-stale={props.intent.stale ? 'true' : undefined} title={props.intent.title}>
            <span className="nc-intent-label">{props.intent.label}</span>
            <p className="nc-intent-text">{props.intent.text}</p>
          </div>
        )
        : <p className="nc-intent-none">{props.intent.text}</p>}
      {props.steps.length > 0 && (
        <ul className="nc-steps" aria-label={t('session.strip.steps.label')}>
          {props.steps.map((s) => <StepItem key={s.key} step={s} fresh={fresh.has(s.key)} />)}
        </ul>
      )}
      {(hidden > 0 || props.lanes.count > 0 || props.artifacts.count > 0) && (
        <div className="nc-chips">
          {hidden > 0 && <AllSteps steps={props.stepsAll} hidden={hidden} />}
          {props.lanes.count > 0 && <Lanes sessionId={props.sessionId} lanes={props.lanes} />}
          {props.artifacts.count > 0 && <Artifacts items={props.artifacts.items} />}
        </div>
      )}
    </section>
  );
}

/**
 * 描いた後に増えた鍵。開いた直後と、セッションを替えた直後は、どれも新しいとは見なさない（並んでいるものが一斉に光らないように）。
 * 描画のたびに今の鍵を覚え直すので、同じ呼び出しが光るのは入ってきた 1 回だけである。
 */
function useFreshKeys(sessionId: string, keys: string[]): Set<string> {
  // 覚え直すのは描き終えた後（layout effect）にする。描く途中で書くと、描き直しのたびに「新しい」が消える。
  const seen = useRef<{ sessionId: string; keys: Set<string> } | null>(null);
  const prev = seen.current;
  const same = prev !== null && prev.sessionId === sessionId;
  const fresh = same ? new Set(keys.filter((k) => !prev.keys.has(k))) : new Set<string>();
  useLayoutEffect(() => {
    const was = seen.current;
    seen.current = { sessionId, keys: new Set([...(was && was.sessionId === sessionId ? was.keys : []), ...keys]) };
  });
  return fresh;
}

/** ツール呼び出し 1 つ。説明（引数の短い形）を先に、道具の名前を後ろに小さく置く。説明が無ければ道具の名前だけ。 */
function StepItem(props: { step: CardStep; fresh?: boolean }) {
  const t = useT();
  const s = props.step;
  return (
    <li className="nc-step" data-mark={s.mark} data-new={props.fresh ? 'true' : undefined}>
      <span className="nc-step-mark" aria-hidden="true">{STEP_MARK[s.mark]}</span>
      <span className="sr-only">{t(`session.strip.step.${s.mark}`)}</span>{' '}
      {s.arg
        ? <><span className="nc-step-arg">{s.arg}</span>{' '}<span className="nc-step-tool">{s.name}</span></>
        : <span className="nc-step-arg">{s.name}</span>}
    </li>
  );
}

/** 「ほか N」の札。押すと直近 30 回までの呼び出しがポップオーバーで開く。 */
function AllSteps(props: { steps: CardStep[]; hidden: number }) {
  const t = useT();
  return (
    <Popover label={t('session.strip.steps.label')} width={360} align="start"
      face={(p) => <CountChip size="sm" label={t('session.strip.stepsMore')} count={props.hidden} {...p} />}>
      <h4 className="pop-title">{t('session.strip.steps.label')}</h4>
      <ul className="nc-steps-all">{props.steps.map((s) => <StepItem key={s.key} step={s} />)}</ul>
    </Popover>
  );
}

/** 見出しの行の「ノート」の札。中身があれば印を付け、押すとポップオーバーでノートを読み書きする。実行中だけ置く（終わった後は冒頭の 1 枚の中）。 */
export function NoteChip(props: { sessionId: string; text: string; filled: boolean }) {
  const t = useT();
  const emit = useEmit();
  return (
    <Popover label={t('session.note.label')} width={340} align="end"
      face={(p) => (
        <button type="button" className="nc-note" data-filled={props.filled ? 'true' : undefined} aria-label={props.filled ? t('session.note.labelFilled') : t('session.note.label')} {...p}>
          <Icon name="edit" />{t('session.note.label')}{props.filled && <span className="nc-note-dot" aria-hidden="true" />}
        </button>
      )}>
      <h4 className="pop-title">{t('session.note.label')}</h4>
      <NoteEditor text={props.text} onSave={(text) => emit({ type: 'session.setMemo', id: props.sessionId, text })} />
    </Popover>
  );
}

/** サブエージェントの札。灯は、失敗、実行中、完了のうち強い方の色。押すと 1 本ずつの一覧が開き、行を押すとその transcript を見る。 */
function Lanes(props: { sessionId: string; lanes: NowCardProps['lanes'] }) {
  const t = useT();
  const emit = useEmit();
  const label = t('session.strip.lanes.label');
  return (
    <Popover label={label} width={400} align="end"
      face={(p) => <CountChip size="sm" label={label} count={props.lanes.count} lead={<span className="live-dot" data-tone={props.lanes.tone} aria-hidden="true" />} {...p} />}>
      {({ close }) => (
        <>
          <h4 className="pop-title">{label}</h4>
          <ul className="nc-lanes">
            {props.lanes.items.map((l: CardLane) => (
              <li key={l.agentId}>
                <button type="button" className="nc-lane-row" data-tone={l.tone} disabled={!l.selectable} title={l.title}
                  onClick={() => { emit({ type: 'transcript.selectAgent', sessionId: props.sessionId, agentId: l.agentId }); close(); }}>
                  <span className="live-dot" data-tone={l.tone} aria-hidden="true" />
                  <span className="nc-lane-title">{l.title}<span className="sr-only"> {l.stateLabel}</span></span>
                  <span className="nc-lane-time num">{l.elapsed}</span>
                  <span className="nc-lane-line">{l.quoted ? t('session.lane.quote', { text: l.line }) : l.line}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Popover>
  );
}

/** アーティファクトの札。押すと一覧が開き、題名を押すと既定のブラウザで、鉛筆を押すと VS Code で開く。 */
function Artifacts(props: { items: ArtifactCardProps[] }) {
  const t = useT();
  const emit = useEmit();
  const label = t('session.strip.artifacts.label');
  return (
    <Popover label={label} width={380} align="end"
      face={(p) => <CountChip size="sm" label={label} count={props.items.length} icon="artifacts" {...p} />}>
      {({ close }) => (
        <>
          <h4 className="pop-title">{label}</h4>
          <ul className="nc-arts">
            {props.items.map((a) => (
              <li key={a.id} className="nc-art">
                <button type="button" className="nc-art-open" title={a.description ?? t('session.artifact.openHint')} onClick={() => { emit({ type: 'artifact.open', id: a.id }); close(); }}>
                  <span className="nc-art-icon" aria-hidden="true">{a.favicon}</span>
                  <span className="nc-art-title">{a.title}</span>
                  <span className="nc-art-when faint">{t('session.artifact.lastPublished', { when: a.lastPublished })}</span>
                </button>
                {a.canOpenEditor && (
                  <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={t('session.artifact.openEditor', { title: a.title })} title={t('session.artifact.openEditor', { title: a.title })} onClick={() => { emit({ type: 'artifact.openEditor', id: a.id }); close(); }}>
                    <Icon name="openEditor" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Popover>
  );
}
