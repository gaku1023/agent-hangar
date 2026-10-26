import { agentIconArt, AGENT_LABEL, type AgentIconKind, type AgentIconTone } from '@agent-hangar/shared';

/**
 * エージェントの絵（shared の agentIcons.ts の組）。
 * tone は置く地の明るさで、light は明るい地、dark は暗い地（ターミナルの板につながるタブ）である。
 * decorative は、隣に名前の語があるとき（タブ）に絵を読み上げから外す。外さないときは、絵そのものがエージェントの名前を持つ。
 */
export function AgentIcon(props: { kind: AgentIconKind; tone?: AgentIconTone; decorative?: boolean }) {
  const tone = props.tone ?? 'light';
  const art = agentIconArt(props.kind, tone);
  const label = AGENT_LABEL[props.kind];
  // 絵の無い種類（古いサーバの知らない値）は、読み上げに名前だけを残して絵を置かない。
  if (!art) return <span className="agent-icon" data-agent={props.kind} data-tone={tone} role={props.decorative ? undefined : 'img'} aria-label={props.decorative ? undefined : label} aria-hidden={props.decorative ? 'true' : undefined} />;
  const svg = (
    <svg viewBox={art.viewBox} width={art.width} height={art.height} aria-hidden="true" focusable="false"
      preserveAspectRatio={art.stretch ? 'none' : undefined} shapeRendering={art.crisp ? 'crispEdges' : undefined}>
      {art.paths.map((p, i) => <path key={i} d={p.d} fill={p.fill} />)}
    </svg>
  );
  return props.decorative
    ? <span className="agent-icon" data-agent={props.kind} data-tone={tone} aria-hidden="true">{svg}</span>
    : <span className="agent-icon" data-agent={props.kind} data-tone={tone} role="img" aria-label={label} title={label}>{svg}</span>;
}
