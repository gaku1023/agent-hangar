import { useLayoutEffect, useRef, useState } from 'react';
import type { InstructionFileKind } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { InstructionRowProps, InstructionsProps } from '../presenters/project.ts';
import { CopyButton } from './primitives/CopyButton.tsx';
import { Dialog } from './primitives/Dialog.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Markdown } from './primitives/Markdown.tsx';
import { fadeIn, motionOn, popOut } from './primitives/motionKit.ts';
import { usePresence } from './primitives/usePresence.ts';

/**
 * 本文を描くダイアログ。開くときは板の pop（.dialog の CSS）に背景のフェードを添え、閉じるときは popOut で逆にたどってから外す。
 * 外枠は display: contents の箱で、背景（.overlay）と板は Dialog の殻が組む。動かすのは中の .overlay である。
 * 閉じている間に選びが消えても、引っ込める間は最後の行を描き続ける。
 */
function FileDialog(props: { projectId: string; row: InstructionRowProps | null; onClose: () => void }) {
  const t = useT();
  const emit = useEmit();
  const last = useRef<InstructionRowProps | null>(props.row);
  if (props.row) last.current = props.row;
  const presence = usePresence<HTMLDivElement>(props.row !== null, (el) => {
    const overlay = el.querySelector<HTMLElement>('.overlay');
    // 動かないとき（reduced motion、試験の環境）は null を返し、その描画のうちに外す。
    return overlay && motionOn(overlay) ? popOut(overlay) : null;
  });
  const { mounted, leaving, ref } = presence;
  useLayoutEffect(() => {
    if (!mounted || leaving) return;
    const overlay = ref.current?.querySelector<HTMLElement>('.overlay');
    if (overlay) fadeIn(overlay);
  }, [mounted, leaving, ref]);
  const row = last.current;
  if (!mounted || !row) return null;
  const open = (kind: InstructionFileKind) => emit({ type: 'instructions.openEditor', projectId: props.projectId, kind });
  return (
    <div ref={ref} className="instr-dialog-host" data-leaving={leaving ? 'true' : undefined}>
      <Dialog
        title={<span className="mono">{row.name}</span>}
        titleAside={<span className="instr-dialog-sub faint">{row.desc} · {row.meta}</span>}
        className="dialog-instr"
        onClose={props.onClose}
        footer={<><span className="spacer" /><button type="button" className="btn" onClick={() => open(row.kind)}><Icon name="openEditor" />{t('projectScreen.instructions.openEditor')}</button></>}
      >
        {row.markdown === null
          ? <p className="muted">{t('projectScreen.instructions.unreadable')}</p>
          : <div className="instr-md"><Markdown text={row.markdown} /></div>}
        {row.truncated && <p className="faint instr-truncated">{t('projectScreen.instructions.truncated')}</p>}
      </Dialog>
    </div>
  );
}

/** 以前のノート。中身があるときだけ出し、削除は確かめてから空で保存する（取り消せないので、赤い丸の確認にする）。 */
function LegacyNote(props: { projectId: string; text: string }) {
  const t = useT();
  const emit = useEmit();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="instr-legacy">
      <p className="instr-legacy-h">{t('projectScreen.legacyNote.title')}</p>
      <p className="instr-legacy-body">{t('projectScreen.legacyNote.body')}</p>
      <pre className="instr-legacy-text">{props.text}</pre>
      <div className="instr-legacy-acts">
        <CopyButton text={props.text} />
        <button type="button" className="btn btn-sm" onClick={() => setConfirming(true)}><Icon name="discard" />{t('projectScreen.legacyNote.delete')}</button>
      </div>
      {confirming && (
        <Dialog
          title={t('projectScreen.legacyNote.confirmTitle')}
          danger
          icon="discard"
          lead={t('projectScreen.legacyNote.confirmBody')}
          onClose={() => setConfirming(false)}
          footer={<><span className="spacer" /><button type="button" className="btn" onClick={() => setConfirming(false)}>{t('common.button.cancel')}</button><button type="button" className="btn btn-danger btn-danger-fill" onClick={() => { setConfirming(false); emit({ type: 'memo.save', projectId: props.projectId, markdown: '' }); }}><Icon name="discard" />{t('projectScreen.legacyNote.delete')}</button></>}
        />
      )}
    </div>
  );
}

/**
 * 右パネルの「指示とメモリ」（案 D）。Claude Code が起動時に読むファイルのうち、あるものだけを 1 行ずつ並べる。
 * 行を押すとダイアログで本文を描き、そのときに読み直しを頼む（ファイルは外で書き換わる）。行の右の印はエディタで開く。
 * Hangar では書かず、無いファイルを作りもしない。読まれるものの全体は /context で見る、と節の下に添える。
 * 節の見出しは、ほかの節と同じく ProjectScreen の RailSection が置く（折りたたみの見出し）。ここは中身だけを描く。
 */
export function InstructionsPanel(props: { projectId: string; instructions: InstructionsProps }) {
  const t = useT();
  const emit = useEmit();
  const { state, rows, legacyNote } = props.instructions;
  const [selected, setSelected] = useState<InstructionFileKind | null>(null);
  const row = rows.find((r) => r.kind === selected) ?? null;
  const show = (kind: InstructionFileKind) => {
    setSelected(kind);
    emit({ type: 'instructions.load', projectId: props.projectId });
  };
  return (
    <>
      {state === 'missing' && <p className="instr-empty">{t('projectScreen.instructions.missing')}</p>}
      {state === 'ready' && rows.length === 0 && <p className="instr-empty">{t('projectScreen.instructions.empty')}</p>}
      {rows.length > 0 && (
        <ul className="instr-list">
          {rows.map((r) => (
            <li key={r.kind} className="instr-row" data-off={r.off ? 'true' : undefined}>
              <button type="button" className="instr-main" aria-label={t('projectScreen.instructions.show', { name: r.name })} onClick={() => show(r.kind)}>
                <span className="instr-name"><span className="mono">{r.name}</span><span className="instr-meta">{r.meta}</span></span>
                <span className="instr-desc">{r.desc}</span>
              </button>
              <button type="button" className="btn instr-open" aria-label={t('projectScreen.instructions.openEditorLabel', { name: r.name })} title={t('projectScreen.instructions.openEditor')}
                onClick={() => emit({ type: 'instructions.openEditor', projectId: props.projectId, kind: r.kind })}><Icon name="openEditor" /></button>
            </li>
          ))}
        </ul>
      )}
      {legacyNote !== null && <LegacyNote projectId={props.projectId} text={legacyNote} />}
      {state !== 'missing' && <p className="instr-foot">{t('projectScreen.instructions.footBefore')}<code>/context</code>{t('projectScreen.instructions.footAfter')}</p>}
      <FileDialog projectId={props.projectId} row={row} onClose={() => setSelected(null)} />
    </>
  );
}
