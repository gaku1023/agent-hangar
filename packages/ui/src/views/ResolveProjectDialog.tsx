import { useState } from 'react';
import { useEmit } from '../intent/chain.tsx';
import { Dialog } from './primitives/Dialog.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

type ResolveAction = { kind: 'repoint'; path: string } | { kind: 'archive' } | { kind: 'unlink' };

/**
 * 場所の無いプロジェクトの扱いを決めるダイアログ（設計書 2.11.5）。保持する状態は新しいパスの入力だけ。
 * 「場所を再指定」を押したときだけ開く。起動時にも、同期の直後にも、作業中にも出さない。
 * 押して開くので、閉じる手（Esc、背景、×、あとで）を持つ。閉じても、帯の錠剤か一覧の札が残るので、いつでも開き直せる。
 * elsewhere は、他の PC から届いただけで、この PC に場所を持ったことが無いもの。見出しと前のパスの札でそれを言い、前のパスと PC の名前は他の PC のものを出す。
 * 開いたら中の最初の操作（新しいパスの欄）にフォーカスを入れる。背景の打鍵がダイアログの裏の一覧へ流れないようにするためである。
 */
export function ResolveProjectDialog(props: { projectId: string; name: string; previousPath: string | null; elsewhere?: boolean; deviceName?: string | null; candidates: string[]; onQueryCandidates: (name: string) => void }) {
  const emit = useEmit();
  const t = useT();
  const [path, setPath] = useState('');
  const resolve = (action: ResolveAction) => emit({ type: 'project.resolve', id: props.projectId, action });
  const close = () => emit({ type: 'overlay.close' });
  const where = props.elsewhere === true && props.deviceName ? t('projects.resolve.previousOn', { device: props.deviceName }) : t('projects.resolve.previous');
  return (
    <Dialog
      title={t(props.elsewhere === true ? 'projects.resolve.titleElsewhere' : 'projects.resolve.title', { name: props.name })}
      icon="warning"
      onClose={close}
      footer={<>
        <button type="button" className="btn" onClick={() => resolve({ kind: 'archive' })}><Icon name="archive" />{t('projects.resolve.archive')}</button>
        {/* 一覧から削除は取り消せず、同期で他の PC にも広がるので危険色にする。押すと Mediator が先に確認を出す。 */}
        <button type="button" className="btn btn-danger" onClick={() => resolve({ kind: 'unlink' })}><Icon name="unlink" />{t('projects.resolve.unlink')}</button>
        <span className="spacer" />
        <button type="button" className="btn" onClick={close}>{t('projects.resolve.later')}</button>
      </>}
    >
      <div>
        <div className="muted" style={{ marginBottom: 4 }}>{where}</div>
        <div className="mono faint">{props.previousPath ?? t('projects.resolve.noPath')}</div>
      </div>
      <p className="muted">{t(props.elsewhere === true ? 'projects.resolve.hintElsewhere' : 'projects.resolve.hint')}</p>
      <div>
        {props.candidates.length > 0 && (
          <>
            <div className="muted" style={{ marginBottom: 4 }}>{t('projects.resolve.candidates')}</div>
            <div className="list" style={{ marginBottom: 8 }}>{props.candidates.map((c) => <div key={c} className="row mono" style={{ gridTemplateColumns: '1fr' }} role="option" aria-selected={c === path} onClick={() => setPath(c)}>{c}</div>)}</div>
          </>
        )}
        <div className="muted" style={{ marginBottom: 4 }}>{t('projects.resolve.newPath')}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input mono" style={{ flex: 1 }} data-autofocus aria-label={t('projects.resolve.newPath')} value={path} onChange={(e) => { setPath(e.target.value); props.onQueryCandidates(e.target.value.split('/').pop() ?? ''); }} placeholder="/Users/you/workspace/..." />
          <button type="button" className="btn btn-primary" disabled={!path} onClick={() => resolve({ kind: 'repoint', path })}><Icon name="repoint" />{t('projects.resolve.useThis')}</button>
        </div>
      </div>
    </Dialog>
  );
}
