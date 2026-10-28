import { useLayoutEffect, useRef } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { CardLane, CardStep, NowCardProps, NowStop, NowUsage } from '../presenters/live.ts';
import type { OverlapProps } from '../presenters/overlap.ts';
import type { ArtifactCardProps } from '../presenters/project.ts';
import { OverlapBlock } from './OverlapPopover.tsx';
import type { SessionGitView } from '../presenters/session.ts';
import { GitFilesPop } from './GitFiles.tsx';
import { CountChip } from './primitives/Chip.tsx';
import { ArtifactIcon, Icon } from './primitives/Icon.tsx';
import { fadeIn, motionOn } from './primitives/motionKit.ts';
import { useT } from './primitives/language.tsx';
import { useEditorLabels } from './primitives/editorName.tsx';
import { Popover } from './primitives/Popover.tsx';
import { ReasonGlyph } from './primitives/StatusDot.tsx';
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
 * opencode の会話だけは、いちばん下に使用量の欄（コンテキストの帯と、トークン・コスト・モデルの小札。試作の C1）を置く。
 * 背は中身に合わせ、伸びるのはすぐ、縮むのは節目だけにする（useCardHeight と usePhaseKey）。
 * 中身（意図の折り返し、手の数、問い）のたびに縮めると、下の目次が押されて跳ねるためである。
 */
export function NowCard(props: NowCardProps & { sessionId: string; overlap?: OverlapProps | null; /** git の札（試作の 2-3 の A）。押すと変更したファイルの一覧が開く。 */ git?: SessionGitView | null }) {
  const t = useT();
  const dot = props.tone === 'wait' ? 'wait' : props.tone === 'busy' ? 'busy' : props.tone === 'aside' ? 'aside' : props.tone === 'limit' ? 'limit' : 'idle';
  // 許可待ちと使用制限は、点の代わりに盾と砂時計を置く（試作の N1）。
  const glyph = props.stop?.kind === 'permission' || props.stop?.kind === 'limit' ? props.stop.kind : null;
  const fresh = useFreshKeys(props.sessionId, props.steps.map((s) => s.key));
  const hidden = props.stepsTotal - props.steps.length;
  const phase = usePhaseKey(props.sessionId, props.tone, props.detail !== null || props.stop !== null, props.stepsTotal);
  const { card, body } = useCardHeight<HTMLElement, HTMLDivElement>(props.sessionId, phase);
  const usageFresh = useAppeared(props.sessionId, props.usage !== null);
  return (
    <section ref={card} className="now-card" data-tone={props.tone} aria-label={t('session.strip.label')}>
      <div ref={body} className="nc-body">
        <div className="nc-head">
          <span className="nc-state" data-tone={props.tone}>
            {glyph ? <ReasonGlyph reason={glyph} /> : <span className="live-dot" data-tone={dot} aria-hidden="true" />}
            <span role="status">{props.state}</span>
          </span>
          {props.sub && <span className="nc-sub">{props.sub}</span>}
        </div>
        {props.detail !== null && (props.question
          ? <p className="nc-question" key={props.detail}><span className="nc-question-label">{props.questionLabel}</span><span className="nc-question-text">{props.detail}</span></p>
          : <p className="nc-detail">{props.detail}</p>)}
        {props.stop && <StopBlock stop={props.stop} />}
        {props.intent.kind === 'said'
          ? (
            <div className="nc-intent" key={props.intent.text} data-stale={props.intent.stale ? 'true' : undefined} title={props.intent.title}>
              <span className="nc-intent-label">{props.intent.label}</span>
              <p className="nc-intent-text">{props.intent.text}</p>
            </div>
          )
          // 意図を送らない設定では、同じ場所と形で、利用者の依頼の冒頭を灰色の見出しで出す（試作 2 節の推す案 A）。
          : props.intent.kind === 'request'
            ? (
              <div className="nc-intent" data-kind="request" key={props.intent.text}>
                <span className="nc-request-label">{props.intent.label}</span>
                <p className="nc-request-text">{props.intent.text}</p>
              </div>
            )
            : props.intent.text && <p className="nc-intent-none">{props.intent.text}</p>}
        {props.steps.length > 0 && (
          <ul className="nc-steps" aria-label={t('session.strip.steps.label')}>
            {props.steps.map((s) => <StepItem key={s.key} step={s} fresh={fresh.has(s.key)} />)}
          </ul>
        )}
        {/* 同じファイルの編集の 1 節。状態の行は止まっている理由の札に譲り、意図とツール呼び出しの下、数の札の上に置く。 */}
        {props.overlap && <OverlapBlock overlap={props.overlap} />}
        {(hidden > 0 || props.lanes.count > 0 || props.artifacts.count > 0 || props.git?.chip) && (
          <div className="nc-chips">
            {hidden > 0 && <AllSteps steps={props.stepsAll} hidden={hidden} />}
            {props.lanes.count > 0 && <Lanes sessionId={props.sessionId} lanes={props.lanes} />}
            {props.artifacts.count > 0 && <Artifacts items={props.artifacts.items} />}
            {props.git?.chip && <GitFilesPop sessionId={props.sessionId} chip={props.git.chip} files={props.git.files} />}
          </div>
        )}
        {props.usage && <UsageBlock usage={props.usage} fresh={usageFresh} />}
      </div>
    </section>
  );
}

/**
 * opencode の使用量の欄（試作の C1）。上に「コンテキスト」と割合、その下に細い帯、いちばん下にトークン・コスト・モデルの小札を並べる。
 * 上限が分からなければ帯の段を出さない。帯の伸びは CSS の幅の補間（--dur）で、数は置き換えるだけにする。
 * 開いたあとに欄が現れたとき（最初の使用量が届いたとき）だけ、薄れから現す（fadeIn）。開いた時点で既にあるものと、セッションを替えたときは動かさない。
 * 読み上げでは 1 つのまとまり（「使用量」）として読み、帯は数と重なるので読ませない。
 */
function UsageBlock(props: { usage: NowUsage; fresh: boolean }) {
  const t = useT();
  const u = props.usage;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (props.fresh && ref.current && motionOn(ref.current)) fadeIn(ref.current);
    // 現れた描画でだけ動かす。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={ref} className="nc-usage" role="group" aria-label={t('session.strip.usage.label')}>
      {u.percent !== null && (
        <div className="nc-usage-ctx">
          <span className="nc-usage-head"><span className="nc-usage-label">{t('session.strip.usage.context')}</span><span className="nc-usage-pct num">{u.percentLabel}</span></span>
          <span className="nc-usage-meter" aria-hidden="true"><i style={{ width: `${u.percent}%` }} /></span>
        </div>
      )}
      {u.chips.length > 0 && (
        <div className="nc-usage-chips">
          {u.chips.map((c) => <span key={c} className="nc-usage-chip">{c}</span>)}
        </div>
      )}
    </div>
  );
}

/**
 * 止まっている理由の欄（試作の N1）。問いと同じ場所に置く。
 * 許可待ちは命令の全文を等幅で折り返し、使用制限はリセットの時刻を太字にして残りの棒を添える。
 */
function StopBlock(props: { stop: NowStop }) {
  const s = props.stop;
  return (
    <div className="nc-stop" data-kind={s.kind}>
      <span className="nc-stop-head">{s.head}</span>
      {s.kind === 'permission' && (
        <>
          {s.command !== null && <code className="nc-stop-cmd">{s.command}</code>}
          {s.why !== null && <p className="nc-stop-why">{s.why}</p>}
          <p className="nc-stop-hint">{s.hint}</p>
        </>
      )}
      {s.kind === 'limit' && (
        <>
          <p className="nc-stop-at">{s.at}</p>
          {s.meter !== null && <span className="nc-stop-meter" aria-hidden="true"><i style={{ width: `${s.meter}%` }} /></span>}
          <p className="nc-stop-hint">{s.hint}</p>
        </>
      )}
      {s.kind === 'reset' && <p className="nc-stop-why">{s.body}</p>}
    </div>
  );
}

/**
 * 札の背の節目の鍵。状態の色（tone）か、問いや裏のシェルの 1 行（detail）の有無が替わるたびに数を進める。
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
 * 同じセッションのまま、無かったものが現れた描画か。開いた直後と、セッションを替えた直後は現れたと見なさない。
 * 覚え直すのは描き終えた後にする（useFreshKeys と同じ）。
 */
function useAppeared(sessionId: string, present: boolean): boolean {
  const seen = useRef<{ sessionId: string; present: boolean } | null>(null);
  const prev = seen.current;
  const appeared = present && prev !== null && prev.sessionId === sessionId && !prev.present;
  useLayoutEffect(() => { seen.current = { sessionId, present }; });
  return appeared;
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
                  <ArtifactIcon name={a.icon} />
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
