import { useLayoutEffect, useRef } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { ShareListProps, ShareRowProps, ShareSettingsProps } from '../presenters/share.ts';
import { useT } from './primitives/language.tsx';
import { collapseOut, growIn, motionOn } from './primitives/motionKit.ts';
import { SetRow } from './primitives/SetRow.tsx';
import { Switch } from './primitives/Switch.tsx';
import { usePresence } from './primitives/usePresence.ts';

/** 入にしたら何を渡すかの一覧の箱。渡すファイル、渡す MCP（名前と札）、渡さないもの（名前と理由）、注記を並べる。 */
function ShareList(props: { list: ShareListProps }) {
  const t = useT();
  const l = props.list;
  return (
    <div className="share-detail">
      {l.empty !== null && <div className="share-empty">{l.empty}</div>}
      {l.files.length > 0 && (
        <>
          <div className="share-h">{t('settings.share.files')}</div>
          <ul className="share-ul">{l.files.map((f) => <li key={f.path}><code>{f.path}</code></li>)}</ul>
        </>
      )}
      {l.mcp.length > 0 && (
        <>
          <div className="share-h">{t('settings.share.mcp')}</div>
          <ul className="share-ul">{l.mcp.map((m) => <li key={m.name}><code>{m.name}</code><span className="share-pill">{m.kind}</span></li>)}</ul>
        </>
      )}
      {l.skipped.length > 0 && (
        <>
          <div className="share-h">{t('settings.share.skipped')}</div>
          <ul className="share-ul">{l.skipped.map((s) => <li key={s.name}><code>{s.name}</code><span className="share-why">{s.reason}</span></li>)}</ul>
        </>
      )}
      {l.notes.map((n) => <div key={n} className="share-note">{n}</div>)}
    </div>
  );
}

/**
 * スイッチ 1 つと、入のときだけ下に伸びる一覧の箱の 1 行。
 * 箱は入れたら growIn で伸ばし、切ったら collapseOut で畳んでから外す。最初の描画では動かさない（Codex・opencode の節の more と同じやり方）。
 */
function ShareRow(props: { label: string; row: ShareRowProps; onToggle: (next: boolean) => void }) {
  const row = props.row;
  const open = row.on && row.list !== null;
  const box = usePresence<HTMLDivElement>(open, (el) => (motionOn(el) ? collapseOut(el) : null));
  // 畳む間も中身を描けるよう、最後の一覧を覚えておく。
  const last = useRef<ShareListProps | null>(row.list);
  if (row.list) last.current = row.list;
  const live = useRef(false);
  const was = useRef(open);
  useLayoutEffect(() => {
    if (live.current && open && !was.current && box.ref.current) growIn(box.ref.current);
    was.current = open;
    live.current = true;
  }, [open, box.ref]);
  return (
    <SetRow title={props.label} desc={row.desc}
      control={<Switch label={props.label} checked={row.on} onChange={props.onToggle} />}
      below={box.mounted && last.current ? <div className="share-more" ref={box.ref}><ShareList list={last.current} /></div> : undefined} />
  );
}

/** 「Claude Code の指示を渡す」「Claude Code の MCP を渡す」の 2 行。入にしたときは、一覧を取り直すよう頼む。 */
export function ShareRows(props: { o: ShareSettingsProps }) {
  const t = useT();
  const emit = useEmit();
  const agent = props.o.agent;
  const cap = agent === 'codex' ? 'codex' : 'opencode';
  const toggle = (key: 'ShareInstructions' | 'ShareMcp') => (next: boolean) => {
    emit({ type: 'settings.update', patch: { [`${cap}${key}`]: next } });
    if (next) emit({ type: 'share.preview', agent });
  };
  return (
    <>
      <ShareRow label={t(agent === 'codex' ? 'settings.label.codexShareInstructions' : 'settings.label.opencodeShareInstructions')} row={props.o.instructions} onToggle={toggle('ShareInstructions')} />
      <ShareRow label={t(agent === 'codex' ? 'settings.label.codexShareMcp' : 'settings.label.opencodeShareMcp')} row={props.o.mcp} onToggle={toggle('ShareMcp')} />
    </>
  );
}
