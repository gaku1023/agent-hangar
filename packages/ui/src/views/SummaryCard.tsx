import { useEmit } from '../action/chain.tsx';
import type { LeadCardProps } from '../presenters/session.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

/**
 * 終わったセッションの要約の札（2026-10-16 の試作の S5）。
 * 右の欄の目次の上、実行中に現在の札（NowCard）が出るのと同じ場所に置き、目次といっしょに ⌘J で畳まれる。
 * 見た目は現在の札に合わせ、左に完了の色の線を引く。
 * 中身は、見出し（「要約」と進捗）、作成中と失敗の知らせ、本文、次のステップ、「要約を再生成」。
 * 作成元（要約器とモデルと時刻）は行にせず、進捗の title で読む。
 * 要約も知らせも無ければ何も描かない（土台の要約は presenter が外している）。
 */
export function SummaryCard(props: Pick<LeadCardProps, 'summary' | 'notice' | 'canRegenerate' | 'regenerate'> & { sessionId: string }) {
  const t = useT();
  const emit = useEmit();
  const { summary, notice } = props;
  if (!summary && !notice) return null;
  const title = t('session.summaryCard.title');
  return (
    <section className="summary-card" aria-label={title}>
      <div className="sc-head">
        <span className="sc-title">{title}</span>
        {summary && <span className="sc-progress" title={summary.sourceLine}>{summary.progress}</span>}
      </div>
      {notice && <p className="sc-notice" data-kind={notice.kind} title={notice.title ?? undefined}>{notice.text}</p>}
      {summary && <p className="sc-body">{summary.body}</p>}
      {summary && summary.nextSteps.length > 0 && (
        <div className="sc-next">
          <span className="sc-sub">{summary.nextStepsLabel}</span>
          <ul>{summary.nextSteps.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </div>
      )}
      {/* 作成中は押させない。失敗したときは、要約が無くてもここから作り直せる。 */}
      {props.canRegenerate && notice?.kind !== 'pending' && (
        <div className="sc-foot">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => emit({ type: 'summary.regenerate', sessionId: props.sessionId })}><Icon name="rebuild" />{props.regenerate}</button>
        </div>
      )}
    </section>
  );
}
