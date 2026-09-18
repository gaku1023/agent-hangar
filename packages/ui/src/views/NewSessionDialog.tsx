import { useRef, useState, type KeyboardEvent } from 'react';
import type { LaunchParams } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { NewSessionProps } from '../presenters/newSession.ts';
import { isComposing } from './ime.ts';
import { Fold } from './primitives/Fold.tsx';

type TextKey = 'name' | 'prompt' | 'model' | 'effort' | 'permissionMode' | 'worktree';
const textKeys: TextKey[] = ['name', 'prompt', 'model', 'effort', 'permissionMode', 'worktree'];

/**
 * 起動ダイアログ。必須はプロジェクトだけで、空欄は params に含めない（利用者の Claude Code の設定に従わせるため）。
 * 入力欄は非制御にして、送信のときにフォームからまとめて読む。
 * 選んだプロジェクトだけは起動ボタンの有効無効に効くので、その値だけを持つ。
 */
export function NewSessionDialog(props: NewSessionProps) {
  const emit = useEmit();
  const form = useRef<HTMLFormElement>(null);
  const [projectId, setProjectId] = useState(props.projectId ?? '');

  const submit = () => {
    if (!projectId || props.submitting || !form.current) return;
    const data = new FormData(form.current);
    const text = (key: string): string => { const v = data.get(key); return typeof v === 'string' ? v.trim() : ''; };
    const params: LaunchParams = { projectId };
    for (const key of textKeys) { const v = text(key); if (v) params[key] = v; }
    const dirs = text('addDirs').split('\n').map((d) => d.trim()).filter(Boolean);
    if (dirs.length) params.addDirs = dirs;
    emit({ type: 'session.new.submit', params });
  };

  // Esc で閉じ、Enter で起動する。
  // 変換中の Enter は確定のための打鍵なので、起動に使わない。
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { emit({ type: 'overlay.close' }); return; }
    if (e.key !== 'Enter' || isComposing(e)) return;
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    e.preventDefault();
    submit();
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="新しいセッション" onKeyDown={onKeyDown}>
      <form ref={form} className="dialog dialog-wide" onSubmit={(e) => e.preventDefault()}>
        <b>新しいセッション</b>
        <label className="field">プロジェクト
          <select className="select" name="projectId" aria-label="プロジェクト" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">選んでください</option>
            {props.projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.path ? `　${p.path}` : ''}</option>)}
          </select>
        </label>
        <label className="field">名前（任意）
          <input id="new-session-name" className="input" name="name" aria-label="名前" defaultValue="" placeholder="一覧での表示名" />
        </label>
        <label className="field">初期プロンプト（任意）
          <textarea className="input" name="prompt" aria-label="初期プロンプト" rows={4} defaultValue="" />
        </label>
        <Fold summary="詳細（model、effort、permission mode、worktree、追加ディレクトリ）">
          <div className="grid2">
            <label className="field">model
              <input className="input mono" name="model" aria-label="model" defaultValue="" placeholder="空なら Claude Code の設定" />
            </label>
            <label className="field">effort
              <input className="input mono" name="effort" aria-label="effort" defaultValue="" placeholder="空なら Claude Code の設定" />
            </label>
            <label className="field">permission mode
              <input className="input mono" name="permissionMode" aria-label="permission mode" defaultValue="" placeholder="空なら Claude Code の設定" />
            </label>
            <label className="field">worktree
              <input className="input mono" name="worktree" aria-label="worktree" defaultValue="" placeholder="空なら通常の作業ディレクトリ" />
            </label>
          </div>
          <label className="field">追加ディレクトリ（1 行 1 つ）
            <textarea className="input mono" name="addDirs" aria-label="追加ディレクトリ" rows={2} defaultValue="" />
          </label>
        </Fold>
        <div className="faint">新しいディレクトリでは Claude が信頼確認のダイアログを出します。起動したあとにターミナルで答えてください。</div>
        {props.error && <div className="error" role="alert">{props.error}</div>}
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={() => emit({ type: 'overlay.close' })}>やめる</button>
          <span className="spacer" />
          <button type="button" className="btn btn-primary" disabled={!projectId || props.submitting} onClick={submit}>{props.submitting ? '起動しています' : '起動'}</button>
        </div>
      </form>
    </div>
  );
}
