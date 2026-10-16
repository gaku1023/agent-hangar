import { useId, useMemo, useState, type ReactNode } from 'react';
import type { LaunchProject } from '../launch.ts';
import { phaseClass, usePresence } from '../presence.ts';
import { BottomSheet } from './BottomSheet.tsx';
import { Choice } from './Choice.tsx';
import { Fold } from './Fold.tsx';

export type Sel = { scratch: true } | { scratch: false; id: string } | null;

/** 札に出す最近使ったプロジェクトの数。 */
export const RECENT_COUNT = 5;
/** 検索の結果に出す件数。 */
const RESULT_COUNT = 5;

type Props = {
  /** 最近使った順。 */
  projects: LaunchProject[];
  sel: Sel;
  onPick: (s: Sel) => void;
  /** PC の ID から名前。 */
  names: Map<string, string>;
};

const label = (p: LaunchProject): string => p.name || p.id;
const matches = (p: LaunchProject, q: string): boolean => label(p).toLowerCase().includes(q);

/**
 * プロジェクトの選び方（B1）。
 * クイックセッションが先頭、最近使った 5 件の札、検索欄、「すべて N 件」で開くシート。
 * 5 件以下なら全部が札になるので、検索欄と「すべて」は出さない。
 */
export function ProjectPicker({ projects, sel, onPick, names }: Props): ReactNode {
  const headId = useId();
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const recent = useMemo(() => projects.slice(0, RECENT_COUNT), [projects]);
  const many = projects.length > RECENT_COUNT;
  const needle = q.trim().toLowerCase();
  const found = useMemo(() => (needle ? projects.filter((p) => matches(p, needle)) : []), [projects, needle]);
  const shown = useMemo(() => found.slice(0, RESULT_COUNT), [found]);
  const pcs = (p: LaunchProject): string => p.deviceIds.map((d) => names.get(d) ?? d).join('、');

  // 最近の札に無いものを選んだら、その 1 件を札の並びの末尾に足す。
  const picked = sel && !sel.scratch ? (projects.find((p) => p.id === sel.id) ?? null) : null;
  const extra = useMemo(() => (picked && !recent.some((p) => p.id === picked.id) ? [picked] : []), [picked, recent]);
  const extraShown = usePresence(extra, (p) => p.id);

  const pick = (p: LaunchProject): void => {
    onPick({ scratch: false, id: p.id });
    setQ('');
    setAll(false);
  };
  const isOn = (p: LaunchProject): boolean => !!sel && !sel.scratch && sel.id === p.id;

  return (
    <section className="ns-sec">
      <h2 className="ns-h" id={headId}>
        プロジェクト
      </h2>
      <div role="radiogroup" aria-labelledby={headId} className="pp">
        <div className="ns-list">
          <Choice checked={!!sel?.scratch} onPick={() => onPick({ scratch: true })} title="クイックセッション" sub="どの PC でも" />
        </div>
        {projects.length > 0 && <p className="pp-sub">最近</p>}
        <div className="pp-chips">
          {recent.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={isOn(p)} className={`pp-chip ${isOn(p) ? 'on' : ''}`} onClick={() => pick(p)}>
              {label(p)}
            </button>
          ))}
          {extraShown.map((x) => (
            <button key={x.key} type="button" role="radio" aria-checked={isOn(x.item)} className={`pp-chip ${isOn(x.item) ? 'on' : ''} ${phaseClass(x.phase)}`} onClick={() => pick(x.item)} aria-hidden={x.phase === 'leave' ? true : undefined}>
              {label(x.item)}
            </button>
          ))}
          {many && (
            <button type="button" className="pp-chip all" onClick={() => setAll(true)}>
              {`すべて ${projects.length} 件 ›`}
            </button>
          )}
        </div>
      </div>

      {many && (
        <>
          <input className="input pp-search" type="text" enterKeyHint="search" autoComplete="off" aria-label="プロジェクトを検索" placeholder={`プロジェクトを検索（${projects.length} 件）`} value={q} onChange={(e) => setQ(e.target.value)} />
          <Results shown={shown} more={found.length - shown.length} empty={!!needle && found.length === 0} pcs={pcs} isOn={isOn} onPick={pick} />
        </>
      )}

      <AllSheet open={all} projects={projects} pcs={pcs} isOn={isOn} onPick={pick} onClose={() => setAll(false)} />
    </section>
  );
}

type RowsProps = { pcs: (p: LaunchProject) => string; isOn: (p: LaunchProject) => boolean; onPick: (p: LaunchProject) => void };

function ProjectRow({ p, pcs, isOn, onPick }: RowsProps & { p: LaunchProject }): ReactNode {
  return (
    <button type="button" role="radio" aria-checked={isOn(p)} className={`prow ${isOn(p) ? 'on' : ''}`} onClick={() => onPick(p)}>
      <span className="prow-name">{label(p)}</span>
      <span className="prow-pcs">
        {pcs(p)
          .split('、')
          .map((n) => (
            <i key={n} className="pcb">
              {n}
            </i>
          ))}
      </span>
    </button>
  );
}

/** 検索の結果。行は伸びて入り、畳んで出る。 */
function Results({ shown, more, empty, pcs, isOn, onPick }: RowsProps & { shown: LaunchProject[]; more: number; empty: boolean }): ReactNode {
  const list = usePresence(shown, (p) => p.id);
  const note = more > 0 ? `ほか ${more} 件（「すべて」で見る）` : empty ? '見つかりません' : null;
  if (shown.length === 0 && !note && list.length === 0) return null;
  return (
    <div role="radiogroup" aria-label="検索結果" className="pp-results">
      {list.map((x) => (
        <Fold key={x.key} phase={x.phase}>
          <ProjectRow p={x.item} pcs={pcs} isOn={isOn} onPick={onPick} />
        </Fold>
      ))}
      {note && <p className="p-mini pp-note m-fade">{note}</p>}
    </div>
  );
}

function AllSheet({ open, projects, pcs, isOn, onPick, onClose }: RowsProps & { open: boolean; projects: LaunchProject[]; onClose: () => void }): ReactNode {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const list = useMemo(() => (needle ? projects.filter((p) => matches(p, needle)) : projects), [projects, needle]);
  return (
    <BottomSheet open={open} title="すべてのプロジェクト" closeText="閉じる" closeLabel="一覧を閉じる" onClose={onClose}>
      <input className="input pp-search" type="text" enterKeyHint="search" autoComplete="off" aria-label="すべてから検索" placeholder="名前で検索" value={q} onChange={(e) => setQ(e.target.value)} />
      <div role="radiogroup" aria-label="すべてのプロジェクト" className="pp-all">
        {list.map((p) => (
          <ProjectRow key={p.id} p={p} pcs={pcs} isOn={isOn} onPick={onPick} />
        ))}
        {list.length === 0 && <p className="p-mini pp-note">見つかりません</p>}
      </div>
    </BottomSheet>
  );
}
