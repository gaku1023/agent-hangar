import type { ConfigPreviewAction, ConfigPreviewDto } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';

const ACTION_LABEL: Record<ConfigPreviewAction, string> = { create: '新しく作る', overwrite: '上書きする', conflict: '競合（控えを残します）', skip: '変更なし' };
const ACTION_ORDER: ConfigPreviewAction[] = ['create', 'overwrite', 'conflict', 'skip'];

/** 何がいくつ変わるかの内訳。押す前に全体の大きさが分かるようにする。 */
function summaryLine(entries: ConfigPreviewDto['entries']): string {
  const count = (a: ConfigPreviewAction) => entries.filter((e) => e.action === a).length;
  return ACTION_ORDER.map((a) => `${ACTION_LABEL[a].replace('（控えを残します）', '')} ${count(a)} 件`).join('、');
}

/**
 * Claude Code 設定の取り込みの下見。
 * 「取り込む」を押すまで ~/.claude には何も書かない（利用者の決定 2）。
 * 書き換える前に控えを取る場所も、押す前に見せておく。
 */
export function ConfigPreviewDialog(props: { preview: ConfigPreviewDto | null }) {
  const emit = useEmit();
  const p = props.preview;
  const hasEntries = !!p && p.entries.length > 0;
  return (
    <div className="overlay" onClick={() => emit({ type: 'overlay.close' })}>
      <div className="dialog dialog-wide" role="dialog" aria-modal="true" aria-label="取り込み内容の確認" onClick={(e) => e.stopPropagation()}>
        <b className="dialog-title">~/.claude に取り込む内容</b>
        {!p && <div className="muted">取り込む内容を調べています</div>}
        {p && !hasEntries && <div className="muted">取り込むものはありません</div>}
        {hasEntries && (
          <>
            <div className="faint">{summaryLine(p.entries)}</div>
            <div className="list list-scroll" style={{ maxHeight: 320 }}>
              {p.entries.map((e) => (
                <div key={e.path} className="row" style={{ gridTemplateColumns: '1fr auto auto', cursor: 'default' }}>
                  <span className="mono">{e.path}</span>
                  <span className="faint">{ACTION_LABEL[e.action]}</span>
                  <span className="faint">{e.remoteDevice}</span>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="faint">上書きする前に ~/.agent-hangar/backups/claude-config/&lt;日時&gt;/ に控えを取ります。控えが取れなかったファイルは書き換えません。</div>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={() => emit({ type: 'overlay.close' })}>やめる</button>
          <span className="spacer" />
          <button type="button" className="btn btn-primary" disabled={!hasEntries} onClick={() => emit({ type: 'sync.config.apply' })}>取り込む</button>
        </div>
      </div>
    </div>
  );
}
