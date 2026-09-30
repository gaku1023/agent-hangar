import { useEmit } from '../intent/chain.tsx';
import type { ConfirmRequest } from '../mediator/types.ts';
import type { ConfirmProjectProps } from '../presenters/confirm.ts';
import { Dialog } from './primitives/Dialog.tsx';
import { Icon } from './primitives/Icon.tsx';

/** 本文の大きさ。KB で足りなくなる長さの本文があるので MB まで見る。 */
const sizeLabel = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);

/**
 * 取り消せない操作の確認。
 * 「この PC で再開」で手元の本文を他の PC の本文に置き換える場面、外のターミナルの claude を引き取る場面、ランを止める場面、
 * 見つからないプロジェクトを一覧から削除する場面を扱う。
 * どうするかを決めるのは利用者なので、View は起きることを並べるだけで判断をしない。
 * 開いた時点のフォーカスは、殻がやめる側に置く。Enter の押し違いで押し切らせないためである。
 */
export function ConfirmDialog(props: { confirm: ConfirmRequest; project?: ConfirmProjectProps | null }) {
  const emit = useEmit();
  const c = props.confirm;
  const close = () => emit({ type: 'overlay.close' });
  const cancel = <button type="button" className="btn" onClick={close}>やめる</button>;
  if (c.kind === 'unlinkProject') {
    const name = props.project?.name ?? c.projectId;
    const sessions = props.project?.sessions ?? 0;
    // 取り消せず、同期で他の PC にも広がるので、赤い丸と赤く塗ったボタンで示す（E1）。
    return (
      <Dialog
        title="一覧から削除しますか"
        danger
        icon="unlink"
        lead={<>プロジェクト <b>{name}</b> を一覧から削除し、{sessions} 件のセッションを未分類に戻します。</>}
        onClose={close}
        footer={<><span className="spacer" />{cancel}<button type="button" className="btn btn-danger btn-danger-fill" onClick={() => emit({ type: 'project.resolve', id: c.projectId, action: { kind: 'unlink' }, confirmed: true })}><Icon name="unlink" />一覧から削除</button></>}
      >
        <div className="muted">同期している他の PC からも消えます。</div>
        <div className="faint">ディレクトリと会話の記録は消しません。</div>
      </Dialog>
    );
  }
  if (c.kind === 'killRun') {
    return (
      <Dialog
        title="停止しますか"
        danger
        icon="stop"
        lead={c.working ? '作業中です。止めると Claude の作業は途中で終わります。' : undefined}
        onClose={close}
        footer={<><span className="spacer" />{cancel}<button type="button" className="btn btn-danger btn-danger-fill" onClick={() => emit({ type: 'session.kill', runId: c.runId, working: c.working, shellTabs: c.shellTabs, confirmed: true })}>停止する</button></>}
      >
        {c.shellTabs > 0 && <div className="muted">シェルタブ {c.shellTabs} 枚も閉じます。</div>}
        <div className="faint">会話の記録は残るので、あとで再開できます。</div>
      </Dialog>
    );
  }
  if (c.kind === 'adoptSession') {
    return (
      <Dialog
        title="hangar で引き取りますか"
        icon="warning"
        onClose={close}
        footer={<>{cancel}<span className="spacer" /><button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.adopt', id: c.sessionId, confirmed: true })}>引き取る</button></>}
      >
        <div className="muted">外のターミナル（VS Code など）で動いている claude を終わらせ、同じ会話を hangar のターミナルで開き直します。</div>
        <div className="faint">答えを待っている問いは、答えなかったものとして閉じます。開いた後に文で答えてください。</div>
        <div className="faint">元のターミナルからは <span className="mono">claude attach</span> で同じ画面に戻れます。</div>
      </Dialog>
    );
  }
  return (
    <Dialog
      title="本文を置き換えますか"
      icon="warning"
      onClose={close}
      footer={<>{cancel}<span className="spacer" /><button type="button" className="btn btn-primary" onClick={() => emit({ type: 'session.resumeHere', id: c.sessionId, overwrite: true })}>上書きして再開</button></>}
    >
      <div className="muted">この PC の本文の方が小さいままです。他の PC の本文で置き換えますか。</div>
      <div>
        <div className="mono faint">この PC の本文 {sizeLabel(c.localSize)}</div>
        <div className="mono faint">他の PC の本文 {sizeLabel(c.remoteSize)}</div>
      </div>
      <div className="faint">置き換える前に ~/.agent-hangar/backups/transcripts/ に控えを取ります。</div>
    </Dialog>
  );
}
