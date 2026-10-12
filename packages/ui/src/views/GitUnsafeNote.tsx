import { CommandLine } from './primitives/CommandLine.tsx';
import { useT } from './primitives/language.tsx';

/**
 * 持ち主の違い（dubious ownership）で git が読むのを断ったときの案内。
 * 訳と、許すコマンド（`git config --global --add safe.directory <場所>`）を写せる形で出す。
 * hangar は git の設定を書かないので、打つのは利用者である。セッションの (i) と、プロジェクトの「ブランチと worktree」に置く。
 */
export function GitUnsafeNote(props: { command: string }) {
  const t = useT();
  return (
    <div className="git-unsafe">
      <p className="git-unsafe-note">{t('gitUi.unsafe.note')}</p>
      <CommandLine command={props.command} />
    </div>
  );
}
