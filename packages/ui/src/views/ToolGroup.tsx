import { useEmit } from '../action/chain.tsx';
import type { TranscriptItem } from '../presenters/session.ts';
import { toolGroupHead } from '../presenters/toolGroups.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { ToolItem } from './ToolItem.tsx';
import { useGroupOpen, useHitsOf, useOpen } from './transcriptOpen.tsx';

type ToolItemProps = Extract<TranscriptItem, { kind: 'tool' }>;

/**
 * 続けて呼んだツールのまとめ（2026-10-16 の試作の T1）。
 * 畳んだ 1 行に、札（「Bash ×5」）、最後の呼び出しの説明、時刻を控えめに並べる。失敗があればその数も添える。
 * 押すと、左の細い線の下に呼び出しを 1 つずつ小さい行（ToolItem の compact）で開き、各行は押すと入出力が開く。
 * 1 回だけの呼び出しは、押すとまとめも中身もいっしょに開く（1 行だけの一覧をもう一度押させない）。
 * 本文の中の検索や検索の結果が中の呼び出しへ跳んだときは開く（transcriptOpen の revealed）。
 * 中の各行は data-item に seq を持つ。検索の印の何番目かは、その中で数える（Transcript）。
 */
export function ToolGroup({ sessionId, items }: { sessionId: string; items: ToolItemProps[] }) {
  const t = useT();
  const emit = useEmit();
  const seqs = items.map((it) => it.seq);
  const [open, setOpen] = useGroupOpen(seqs);
  const [, setFirstOpen] = useOpen(seqs[0]!, 'tool');
  const hits = useHitsOf(seqs);
  const head = toolGroupHead(items, t);
  const single = items.length === 1 ? items[0]! : null;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (single) setFirstOpen(next);
  };
  return (
    <div className="tool-group" data-open={open ? 'true' : undefined} data-failed={head.failed > 0 ? 'true' : undefined}>
      <button type="button" className="tg-row" aria-expanded={open} title={head.desc} onClick={toggle}>
        <span className="chev"><Icon name="chevron" /></span>
        <span className="tg-badge">{head.label}</span>
        <span className="tg-desc">{head.desc}</span>
        {head.failedLabel && <span className="tg-failed">{head.failedLabel}</span>}
        {!open && hits > 0 && <span className="hitcount">{t('transcript.tool.hits', { n: hits })}</span>}
        <span className="tg-when">{head.when}</span>
      </button>
      {open && (
        <div className="tg-list">
          {items.map((it) => <div key={it.seq} data-item={it.seq}><ToolItem sessionId={sessionId} item={it} compact /></div>)}
        </div>
      )}
      {/* サブエージェントを起こした呼び出しは 1 つで置かれる。畳んでいる間も、その会話へ移るボタンを出す（開くと中の行が出す）。 */}
      {!open && single?.subagent && <div className="sub"><button className="btn btn-sm" onClick={() => emit({ type: 'transcript.selectAgent', sessionId, agentId: single.subagent!.agentId })}><Icon name="subagent" /><span className="btn-label">{t('transcript.tool.viewSubagent', { id: single.subagent.agentId })}</span></button></div>}
    </div>
  );
}
