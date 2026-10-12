import { useLayoutEffect, useRef } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { CardLane, CardStep, NowCardProps } from '../presenters/live.ts';
import type { ArtifactCardProps } from '../presenters/project.ts';
import type { SessionGitView } from '../presenters/session.ts';
import { GitFilesPop } from './GitFiles.tsx';
import { CountChip } from './primitives/Chip.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { useEditorLabels } from './primitives/editorName.tsx';
import { Popover } from './primitives/Popover.tsx';
import { useCardHeight } from './useCardHeight.ts';

/** ツール呼び出しの印。色だけに頼らないよう、形も変える（完了は ✓、いまと入力待ちは ●、失敗は ✕）。読み上げには語で言う。 */
const STEP_MARK = { done: '✓', now: '●', wait: '●', fail: '✕' } as const;

/**
 * 現在の札（2026-10-11 の試作の A2）。セッション画面の右の欄の上、目次の上に置く。
 * タブの列やターミナルにはくっつけない。中身はタブ（Claude かシェルか）ではなく、セッションのものだからである。
 * 上から、状態の行、入力待ちの問い（裏だけ動いているときはその 1 行）、意図の全文、直近 3 つのツール呼び出し、
 * 「ほか N」、サブエージェント、アーティファクトの数の札を積む。意図は切らずに折り返す。
 * 札の全体は読み上げの領域にせず（追記のたびに読み上げない）、状態の語だけを role="status" にする。
 * 動き（D3）：描いた後に増えた呼び出しはフェードで入り一度だけ光る。意図は替わったときにフェードで入れ替わる。灯は静止する。
 * 背は中身に合わせ、伸びるのはすぐ、縮むのは節目だけにする（useCardHeight と usePhaseKey）。
 * 中身（意図の折り返し、手の数、問い）のたびに縮めると、下の目次が押されて跳ねるためである。
 */
export function NowCard(props: NowCardProps & { sessionId: string; /** git の札（試作の 2-3 の A）。押すと変更したファイルの一覧が開く。 */ git?: SessionGitView | null }) {
  const t = useT();
  const dot = props.tone === 'wait' ? 'wait' : props.tone === 'busy' ? 'busy' : props.tone === 'aside' ? 'aside' : 'idle';
  const fresh = useFreshKeys(props.sessionId, props.steps.map((s) => s.key));
  const hidden = props.stepsTotal - props.steps.length;
  const phase = usePhaseKey(props.sessionId, props.tone, props.detail !== null, props.stepsTotal);
  const { card, body } = useCardHeight<HTMLElement, HTMLDivElement>(props.sessionId, phase);
  return (
    <section ref={card} className="now-card" data-tone={props.tone} aria-label={t('session.strip.label')}>
      <div ref={body} className="nc-body">
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
        {(hidden > 0 || props.lanes.count > 0 || props.artifacts.count > 0 || props.git?.chip) && (
          <div className="nc-chips">
            {hidden > 0 && <AllSteps steps={props.stepsAll} hidden={hidden} />}
            {props.lanes.count > 0 && <Lanes sessionId={props.sessionId} lanes={props.lanes} />}
            {props.artifacts.count > 0 && <Artifacts items={props.artifacts.items} />}
            {props.git?.chip && <GitFilesPop sessionId={props.sessionId} chip={props.git.chip} files={props.git.files} />}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * 札の背の節目の鍵。状態の色（tone）か、問いやサブエージェントの 1 行（detail）の有無が替わるたびに数を進める。
 * 新しいターンの始まり（作業中に入って手がまだ無い）は節目にしない。前のターンの背を保ち、手が埋まるまで縮めない。
 * そのときも見た状態は覚え直すので、手が入ってきても鍵は替わらず、次に縮むのはその次の節目になる。
 */
function usePhaseKey(sessionId: string, tone: NowCardProps['tone'], detail: boolean, stepsTotal: number): string {
  const seen = useRef<{ sessionId: string; phase: string; n: number } | null>(null);
  const phase = `${tone}:${detail ? 'detail' : '-'}`;
  const turnStart = tone === 'busy' && stepsTotal === 0;
  const prev = seen.current;
  const n = prev === null || prev.sessionId !== sessionId ? 0 : prev.phase === phase || turnStart ? prev.n : prev.n + 1;
  // 覚え直すのは描き終えた後にする（描き直しで数が進まないように）。
  useLayoutEffect(() => { seen.current = { sessionId, phase, n }; });
  return String(n);
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
  const editorLabels = useEditorLabels();
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
                  <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={editorLabels.openFor(a.title)} title={editorLabels.openFor(a.title)} onClick={() => { emit({ type: 'artifact.openEditor', id: a.id }); close(); }}>
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
