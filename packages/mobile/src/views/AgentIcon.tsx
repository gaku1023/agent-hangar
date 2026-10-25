import { AGENT_ICONS, AGENT_LABEL, type AgentIconKind } from '@agent-hangar/shared/src/agentIcons.ts';
import type { ReactNode } from 'react';

/**
 * 行の題名の左に置くエージェントの絵（shared の agentIcons.ts の組）。幅 20px の枠にそろえる（試作 L1）。
 * 絵は React の要素として描く。SVG の文字列（agentIconSvg）を流し込むと innerHTML が要り、noInnerHtml.test.ts の守りを破るからである。
 * スマホは常に明るい配色なので、明るい地用の絵だけを使う。
 * kind が null（知らないエージェント）なら、絵の無い枠だけを置いて題名の頭をそろえる（違う会社の絵で取り違えさせない）。
 */
export function AgentIcon({ kind }: { kind: AgentIconKind | null }): ReactNode {
  if (!kind) return <span className="agent-icon" aria-hidden="true" />;
  const art = AGENT_ICONS[kind].light;
  const label = AGENT_LABEL[kind];
  return (
    <span className="agent-icon" data-agent={kind} role="img" aria-label={label} title={label}>
      <svg viewBox={art.viewBox} width={art.width} height={art.height} aria-hidden="true" focusable="false" preserveAspectRatio={art.stretch ? 'none' : undefined} shapeRendering={art.crisp ? 'crispEdges' : undefined}>
        {art.paths.map((p, i) => (
          <path key={i} d={p.d} fill={p.fill} />
        ))}
      </svg>
    </span>
  );
}
