import type { BadgeProps } from '../presenters/session.ts';

/**
 * 見出しの名前の横の札（設計書 2.3、9 章の 4）。
 * 他の PC で実行中（または応答がない）ことと、トランスクリプトが他の PC にあること。
 * どちらも再開とフォークを押せない理由なので、ポップオーバーに隠さず、見出しに出す。
 * 最終確認の時刻は title と、読み上げの文に入れる。
 */
export function SessionBadges(props: { badges: BadgeProps[] }) {
  if (props.badges.length === 0) return null;
  return (
    <span className="session-badges">
      {props.badges.map((b) => (
        <span key={b.kind} className="session-badge" data-kind={b.kind} title={b.title ?? undefined}>
          {b.label}{b.title && <span className="sr-only">、{b.title}</span>}
        </span>
      ))}
    </span>
  );
}
