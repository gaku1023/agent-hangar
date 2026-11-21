import { useMemo, useState, type ReactNode } from 'react';
import type { LaunchProject } from '../launch.ts';
import { Choice } from './Choice.tsx';

export type Sel = { scratch: true } | { scratch: false; id: string } | null;

/** これを超える件数のときだけ、検索欄を出す。 */
export const SEARCH_FROM = 5;

type Props = {
  /** 最近使った順。 */
  projects: LaunchProject[];
  sel: Sel;
  onPick: (s: Sel) => void;
  /** PC の ID から名前。 */
  names: Map<string, string>;
};

export const projectLabel = (p: LaunchProject): string => p.name || p.id;

/**
 * プロジェクトの一覧（起動の画面の「プロジェクト」の札を押したときのシートの中身）。
 * クイックセッションが先頭、続けて最近使った順の全件。多いときだけ検索欄を出す。
 */
export function ProjectPicker({ projects, sel, onPick, names }: Props): ReactNode {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const list = useMemo(() => (needle ? projects.filter((p) => projectLabel(p).toLowerCase().includes(needle)) : projects), [projects, needle]);
  const pcs = (p: LaunchProject): string[] => p.deviceIds.map((d) => names.get(d) ?? d);
  const isOn = (p: LaunchProject): boolean => !!sel && !sel.scratch && sel.id === p.id;

  return (
    <>
      {projects.length > SEARCH_FROM && <input className="input pp-search" type="text" enterKeyHint="search" autoComplete="off" aria-label="プロジェクトを検索" placeholder="検索" value={q} onChange={(e) => setQ(e.target.value)} />}
      <div role="radiogroup" aria-label="プロジェクト" className="pick-list pp-all">
        {!needle && <Choice checked={!!sel?.scratch} onPick={() => onPick({ scratch: true })} title="クイックセッション" />}
        {list.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={isOn(p)} className={`prow ${isOn(p) ? 'on' : ''}`} onClick={() => onPick({ scratch: false, id: p.id })}>
            <span className="prow-name">{projectLabel(p)}</span>
            <span className="prow-pcs">
              {pcs(p).map((n) => (
                <i key={n} className="pcb">
                  {n}
                </i>
              ))}
            </span>
          </button>
        ))}
        {needle && list.length === 0 && <p className="p-mini pp-note">見つかりません</p>}
      </div>
    </>
  );
}
