import type { GitChipProps } from '../presenters/git.ts';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { RollingText } from './primitives/RollingText.tsx';

/** 札を一度でも描いた行。初めて値が届いたときだけ薄れから現し、一覧を送るたびに描き直しで光らせない。 */
const shown = new Set<string>();

/**
 * git の札（試作の 2-1 の A）。ブランチの印とブランチの名前（150px で切り、全文は title）、「・」、未コミットの件数か変更なし。
 * worktree は分かれ道の印と worktree の名前と小札「worktree」、他の PC は画面の印と本文の gitBranch。
 * 同じ作業ツリーで実行中のセッションがほかにあれば「共有 N」を添える。件数が変わったら、その語だけを回す（RollingText）。
 * 取得中は札を出さない。届いたら --dur-fast で薄れから現す（シマーやスケルトンは使わない）。
 * id は薄れの覚えの鍵で、同じ行の札が 2 度現れないようにする。
 */
export function GitChip(props: { id: string; chip: GitChipProps; className?: string }) {
  const t = useT();
  const c = props.chip;
  const fresh = !shown.has(props.id);
  if (fresh) shown.add(props.id);
  const icon = c.kind === 'remote' ? 'otherPc' : c.worktree ? 'worktree' : 'branch';
  return (
    <span className={props.className ? `gitchip ${props.className}` : 'gitchip'} data-kind={c.kind} data-fresh={fresh ? 'true' : undefined} title={c.title}>
      <span className="sr-only">{c.label}</span>
      <span className="gitchip-face" aria-hidden="true">
        <Icon name={icon} />
        {c.name !== '' && <span className="gitchip-br mono">{c.name}</span>}
        {c.worktree && c.kind === 'ok' && <span className="gitchip-wt">{t('gitUi.chip.worktree')}</span>}
        {c.name !== '' && <span className="gitchip-sep">·</span>}
        <RollingText text={c.value} className={c.dirty ? 'gitchip-val num' : 'gitchip-val gitchip-quiet num'} />
        {c.shared !== null && <span className="gitchip-share" title={c.sharedTitle ?? undefined}>{t('gitUi.chip.shared', { n: c.shared })}</span>}
      </span>
    </span>
  );
}
