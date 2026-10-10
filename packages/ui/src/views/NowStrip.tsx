import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { NowStripProps, StripLane, StripStep } from '../presenters/live.ts';
import type { ArtifactCardProps } from '../presenters/project.ts';
import { NoteEditor } from './NoteEditor.tsx';
import { CountChip } from './primitives/Chip.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Popover, type PopoverFaceProps } from './primitives/Popover.tsx';
import { fitCountWithMore } from './nowFit.ts';

/** 帯のツール呼び出しの印。色だけに頼らないよう、形も変える（完了は ✓、いまと入力待ちは ●、失敗は ✕）。読み上げには語で言う。 */
const STEP_MARK = { done: '✓', now: '●', wait: '●', fail: '✕' } as const;

/**
 * 現在の帯（設計書 2.3 の C、試作 C の `.now-strip`）。ターミナルの真上に置く 2 行。
 * 1 行目は状態の語と問い、右端にいまの値（コンテキスト使用量、コスト、ターン）と「ノート」の札。
 * 2 行目は意図、ツール呼び出しの並び、サブエージェントとアーティファクトの数の札である。
 * 帯の全体は読み上げの領域にせず（追記のたびに読み上げない）、状態の語だけを role="status" にする。
 * サブエージェント 1 本ずつ、直近より前のツール呼び出し、アーティファクトの一覧は、数の札を押すポップオーバーに入れる。
 * 帯の幅が足りなければ（container query で 720px 未満）、2 行目が折り返し、いまの値が 3 行目に下がる。
 */
export function NowStrip(props: NowStripProps & { sessionId: string }) {
  const t = useT();
  const { values: v } = props;
  const dot = props.tone === 'wait' ? 'wait' : props.tone === 'busy' ? 'busy' : props.tone === 'aside' ? 'aside' : 'idle';
  return (
    <section className="now-strip" data-tone={props.tone} aria-label={t('session.strip.label')}>
      <div className="ns-body">
        <div className="ns-head">
          <span className="ns-state" data-tone={props.tone}>
            <span className="live-dot" data-tone={dot} aria-hidden="true" />
            <span role="status">{props.state}</span>
            {props.sub && <span className="faint ns-sub">{props.sub}</span>}
          </span>
          {props.detail ? <span className="ns-q" title={props.detail}>{props.detail}</span> : <span className="spacer" />}
        </div>
        <div className="ns-vals">
          {v.noUsage ? <span className="faint">{v.noUsage}</span> : (
            <>
              {v.context.missing || v.context.percent === null
                ? <span className="faint">{v.context.missing}</span>
                : (
                  <span>{v.context.label}{' '}
                    <span className="gauge-bar" role="meter" aria-label={v.context.label} aria-valuenow={v.context.percent} aria-valuemin={0} aria-valuemax={100} aria-valuetext={`${v.context.percent}%`}>
                      <span className="gauge-fill" data-high={v.context.percent >= 80 ? 'true' : undefined} style={{ width: `${Math.max(0, Math.min(100, v.context.percent))}%` }} />
                    </span>{' '}
                    <b>{v.context.percent}%</b>
                  </span>
                )}
              {v.cost.missing || v.cost.value === null ? <span className="faint">{v.cost.missing}</span> : <span title={v.cost.label}><b>{v.cost.value}</b></span>}
            </>
          )}
          <span><b>{v.turns}</b></span>
          <span>{v.tokens}</span>
          <NoteChip sessionId={props.sessionId} text={props.note.text} filled={props.note.filled} />
        </div>
        <div className="ns-detail">
          {props.intent.kind === 'said'
            ? <span className="ns-intent" data-stale={props.intent.stale ? 'true' : undefined} title={props.intent.title}>{props.intent.text}<small>{props.intent.time}</small></span>
            : <span className="ns-intent-none faint">{props.intent.text}</span>}
          <Steps steps={props.steps} total={props.stepsTotal} all={props.stepsAll} />
          <span className="ns-chips">
            {props.lanes.count > 0 && <Lanes sessionId={props.sessionId} lanes={props.lanes} />}
            {props.artifacts.count > 0 && <Artifacts items={props.artifacts.items} />}
          </span>
        </div>
      </div>
    </section>
  );
}

/** 「ノート」の札。中身があれば印を付け、押すとポップオーバーでノートを読み書きする。 */
function NoteChip(props: { sessionId: string; text: string; filled: boolean }) {
  const t = useT();
  const emit = useEmit();
  return (
    <Popover label={t('session.note.label')} width={340} align="end"
      face={(p) => (
        <button type="button" className="ns-note" data-filled={props.filled ? 'true' : undefined} aria-label={props.filled ? t('session.note.labelFilled') : t('session.note.label')} {...p}>
          <Icon name="edit" />{t('session.note.label')}{props.filled && <span className="ns-note-dot" aria-hidden="true" />}
        </button>
      )}>
      <h4 className="pop-title">{t('session.note.label')}</h4>
      <NoteEditor text={props.text} onSave={(text) => emit({ type: 'session.setMemo', id: props.sessionId, text })} />
    </Popover>
  );
}

function StepItem(props: { step: StripStep }) {
  const t = useT();
  const s = props.step;
  return (
    <span role="listitem" className="ns-step" data-mark={s.mark}>
      <span className="ns-step-mark" aria-hidden="true">{STEP_MARK[s.mark]}</span>
      <span className="sr-only">{t(`session.strip.step.${s.mark}`)}</span>{' '}
      <i>{s.name}</i>{s.arg && <span className="ns-step-arg"> {s.arg}</span>}
    </span>
  );
}

/**
 * 直近のツール呼び出し。入り切らない札は途中で切らず、丸ごと落として「ほか N」を置く。
 * 最後の呼び出しは「いま」や入力待ちの印を持つので、落とすのは古い側からにする。「ほか N」は、落とした分とそれより前の呼び出しの数で、左に置く。
 * 押すと直近 30 回までの全部がポップオーバーで開く。
 * 落とす数は描いた後の幅で決める。札と「ほか N」を見えない写し（.ns-steps-measure）に全部並べて幅を測り、列の幅と見比べる（fitCountWithMore）。
 * 帯の幅が変わったとき（窓、サイドバーの開閉、container query で行が替わるとき）は ResizeObserver で測り直す。
 */
function Steps(props: { steps: StripStep[]; total: number; all: StripStep[] }) {
  const t = useT();
  const host = useRef<HTMLSpanElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const n = props.steps.length;
  const [shown, setShown] = useState(n);
  const sig = `${props.steps.map((s) => `${s.key}:${s.mark}:${s.arg}`).join('|')}#${props.total}`;
  useLayoutEffect(() => {
    const el = host.current;
    const m = measure.current;
    if (!el || !m) return;
    const fit = () => {
      const kids = [...m.children] as HTMLElement[];
      const moreWidth = kids[0]?.offsetWidth ?? 0;
      const gap = parseFloat(getComputedStyle(el).columnGap);
      // 古い側から落とすので、新しい側から数える。
      const widths = kids.slice(1).map((k) => k.offsetWidth).reverse();
      setShown(fitCountWithMore(widths, Number.isFinite(gap) ? gap : 10, el.clientWidth, moreWidth));
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    let last = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== last) { last = el.clientWidth; fit(); } });
    ro.observe(el);
    return () => ro.disconnect();
  }, [sig]);
  if (n === 0) return <span className="ns-steps-wrap" />;
  const k = Math.min(shown, n);
  const hidden = props.total - k;
  const more = (count: number, face?: (p: PopoverFaceProps) => ReactNode) => face
    ? <Popover label={t('session.strip.steps.label')} width={420} align="start" face={face}>
        <h4 className="pop-title">{t('session.strip.steps.label')}</h4>
        <div className="ns-steps-all" role="list">{props.all.map((s) => <StepItem key={s.key} step={s} />)}</div>
      </Popover>
    : <CountChip size="sm" label={t('session.strip.stepsMore')} count={count} />;
  return (
    <span ref={host} className="ns-steps-wrap" title={hidden > 0 ? t('session.strip.steps.label') : undefined}>
      {hidden > 0 && more(hidden, (p) => <CountChip size="sm" label={t('session.strip.stepsMore')} count={hidden} {...p} />)}
      <span className="ns-steps" role="list" aria-label={t('session.strip.steps.label')}>
        {props.steps.slice(n - k).map((s) => <StepItem key={s.key} step={s} />)}
      </span>
      <span ref={measure} className="ns-steps-measure" aria-hidden="true">
        {more(props.total)}
        {props.steps.map((s) => <span key={s.key} className="ns-step" data-mark={s.mark}><span className="ns-step-mark">{STEP_MARK[s.mark]}</span> <i>{s.name}</i>{s.arg && <span className="ns-step-arg"> {s.arg}</span>}</span>)}
      </span>
    </span>
  );
}

/** サブエージェントの札。灯は、失敗、実行中、完了のうち強い方の色。押すと 1 本ずつの一覧が開き、行を押すとその transcript を見る。 */
function Lanes(props: { sessionId: string; lanes: NowStripProps['lanes'] }) {
  const t = useT();
  const emit = useEmit();
  const label = t('session.strip.lanes.label');
  return (
    <Popover label={label} width={400} align="end"
      face={(p) => <CountChip size="sm" label={label} count={props.lanes.count} lead={<span className="live-dot" data-tone={props.lanes.tone} aria-hidden="true" />} {...p} />}>
      {({ close }) => (
        <>
          <h4 className="pop-title">{label}</h4>
          <ul className="ns-lanes">
            {props.lanes.items.map((l: StripLane) => (
              <li key={l.agentId}>
                <button type="button" className="ns-lane-row" data-tone={l.tone} disabled={!l.selectable} title={l.title}
                  onClick={() => { emit({ type: 'transcript.selectAgent', sessionId: props.sessionId, agentId: l.agentId }); close(); }}>
                  <span className="live-dot" data-tone={l.tone} aria-hidden="true" />
                  <span className="ns-lane-title">{l.title}<span className="sr-only"> {l.stateLabel}</span></span>
                  <span className="ns-lane-time num">{l.elapsed}</span>
                  <span className="ns-lane-line">{l.quoted ? t('session.lane.quote', { text: l.line }) : l.line}</span>
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
          <ul className="ns-arts">
            {props.items.map((a) => (
              <li key={a.id} className="ns-art">
                <button type="button" className="ns-art-open" title={a.description ?? t('session.artifact.openHint')} onClick={() => { emit({ type: 'artifact.open', id: a.id }); close(); }}>
                  <span className="ns-art-icon" aria-hidden="true">{a.favicon}</span>
                  <span className="ns-art-title">{a.title}</span>
                  <span className="ns-art-when faint">{t('session.artifact.lastPublished', { when: a.lastPublished })}</span>
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
