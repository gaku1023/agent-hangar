import { useRef, type KeyboardEvent } from 'react';
import type { LaunchParams } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { NewSessionProps } from '../presenters/newSession.ts';
import { isComposing } from './ime.ts';
import { Fold } from './primitives/Fold.tsx';

type TextKey = 'name' | 'prompt' | 'model' | 'effort' | 'permissionMode' | 'worktree';
const textKeys: TextKey[] = ['name', 'prompt', 'model', 'effort', 'permissionMode', 'worktree'];

/**
 * 起動ダイアログ。必須はプロジェクトだけで、空欄は params に含めない（利用者の Claude Code の設定に従わせるため）。
 * 入力欄はすべて非制御にして、送信のときにフォームからまとめて読む。View は状態を持たない。
 * プロジェクトが未選択のまま送っても止めない。未選択の判定は Mediator が持ち、失敗のメッセージが error として戻ってくる。
 */
export function NewSessionDialog(props: NewSessionProps) {
  const emit = useEmit();
  const form = useRef<HTMLFormElement>(null);

  const submit = () => {
    if (props.submitting || !form.current) return;
    const data = new FormData(form.current);
    const text = (key: string): string => { const v = data.get(key); return typeof v === 'string' ? v.trim() : ''; };
    const params: LaunchParams = {};
    const projectId = text('projectId');
    if (projectId) params.projectId = projectId;
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
        <label className="field" htmlFor="new-session-project">プロジェクト
          <select id="new-session-project" className="select" name="projectId" defaultValue={props.projectId ?? ''}>
            <option value="">選んでください</option>
            {props.projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.path ? `　${p.path}` : ''}</option>)}
          </select>
        </label>
        <label className="field" htmlFor="new-session-name">名前（任意）
          <input id="new-session-name" className="input" name="name" defaultValue="" placeholder="一覧での表示名" />
        </label>
        <label className="field" htmlFor="new-session-prompt">初期プロンプト（任意）
          <textarea id="new-session-prompt" className="input" name="prompt" rows={4} defaultValue="" />
        </label>
        <Fold summary="詳細（model、effort、permission mode、worktree、追加ディレクトリ）">
          <div className="grid2">
            <label className="field" htmlFor="new-session-model">model
              <input id="new-session-model" className="input mono" name="model" defaultValue="" placeholder="空なら Claude Code の設定" />
            </label>
            <label className="field" htmlFor="new-session-effort">effort
              <input id="new-session-effort" className="input mono" name="effort" defaultValue="" placeholder="空なら Claude Code の設定" />
            </label>
            <label className="field" htmlFor="new-session-permission-mode">permission mode
              <input id="new-session-permission-mode" className="input mono" name="permissionMode" defaultValue="" placeholder="空なら Claude Code の設定" />
            </label>
            <label className="field" htmlFor="new-session-worktree">worktree
              <input id="new-session-worktree" className="input mono" name="worktree" defaultValue="" placeholder="空なら通常の作業ディレクトリ" />
            </label>
          </div>
          <label className="field" htmlFor="new-session-add-dirs">追加ディレクトリ（1 行 1 つ）
            <textarea id="new-session-add-dirs" className="input mono" name="addDirs" rows={2} defaultValue="" />
          </label>
        </Fold>
        <div className="faint">新しいディレクトリでは Claude が信頼確認のダイアログを出します。起動したあとにターミナルで答えてください。</div>
        {props.error && <div className="error" role="alert">{props.error}</div>}
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={() => emit({ type: 'overlay.close' })}>やめる</button>
          <span className="spacer" />
          <button type="button" className="btn btn-primary" disabled={props.submitting} onClick={submit}>{props.submitting ? '起動しています' : '起動'}</button>
        </div>
      </form>
    </div>
  );
}
